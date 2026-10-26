/**
 * TypeExtractor — Infragistics WPF reflection-based type metadata extractor
 *
 * Usage:  dotnet run --project scripts/type-extractor -- <packages-dir> <output-file>
 *
 * Loads every InfragisticsWPF / Infragistics.WPF DLL found in <packages-dir>,
 * walks all public types, and writes nuget/type-info.json in the exact format
 * expected by scripts/build-api.ts loadTypeInfo().
 *
 * Output format (flat object):
 *   "__baseTypes"               : { "Assembly|Namespace.Type" : "BaseAssembly|BaseNamespace.BaseType" }
 *                                 (only for Infragistics bases; a generic base as its definition, "…ResourceSet`1")
 *   "Assembly|Namespace.Type.PropName"  : { typeName, isNullable, isEnum, enumValues? }    (instance and static)
 *   "Assembly|Namespace.Type.FieldName" : { typeName, isNullable, isEnum, isField: true }  (static ResourceKey/RoutedCommand fields)
 *   "__xaml"                    : { "Assembly|Namespace.Type" (nested: "…|Namespace.Outer.Inner") : { xmlns, prefix, ns, xamlName? } }
 *   "__nonPublicTypes"          : [ "Assembly|Namespace.Type", … ]   (internal / private nested types, to leave out)
 *   "__nonPublicMembers"        : [ "Assembly|Namespace.Type.Member", … ]   (internal / private members, to leave out)
 */

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.Json;

// ── Argument / path resolution ────────────────────────────────────────────────

var root = FindRoot(AppContext.BaseDirectory);
var packagesDir = args.Length > 0
    ? Path.GetFullPath(args[0])
    : Path.Combine(root, "nuget", "packages");
var outputFile = args.Length > 1
    ? Path.GetFullPath(args[1])
    : Path.Combine(root, "nuget", "type-info.json");

Console.Error.WriteLine($"[TypeExtractor] packages : {packagesDir}");
Console.Error.WriteLine($"[TypeExtractor] output   : {outputFile}");

if (!Directory.Exists(packagesDir)) {
    Console.Error.WriteLine($"[TypeExtractor] ERROR: packages dir not found: {packagesDir}");
    Console.Error.WriteLine("Run: npm run docs:restore");
    return 1;
}

// ── Discover DLL files ────────────────────────────────────────────────────────

var preferredTfms = new[] {
    "net10.0-windows7.0", "net9.0-windows7.0", "net8.0-windows7.0",
    "net8.0-windows", "net7.0-windows7.0", "net6.0-windows7.0", "net40"
};

// filename → best-match dll path  (deduplicate across packages)
var dllByFilename = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

foreach (var pkgDir in Directory.EnumerateDirectories(packagesDir).OrderBy(x => x)) {
    var pkgName = Path.GetFileName(pkgDir);
    if (!pkgName.StartsWith("infragistics.wpf", StringComparison.OrdinalIgnoreCase) &&
        !pkgName.StartsWith("infragistics4", StringComparison.OrdinalIgnoreCase))
        continue;

    // Latest version directory
    var versionDir = Directory.EnumerateDirectories(pkgDir).OrderByDescending(x => x).FirstOrDefault();
    if (versionDir == null) continue;

    string? libDir = null;
    foreach (var tfm in preferredTfms) {
        var candidate = Path.Combine(versionDir, "lib", tfm);
        if (Directory.Exists(candidate)) { libDir = candidate; break; }
    }
    if (libDir == null) continue;

    foreach (var dll in Directory.EnumerateFiles(libDir, "*.dll")) {
        var fname = Path.GetFileName(dll);
        // Only Infragistics assemblies (skip Design DLLs)
        if (!IsInfragisticsDll(fname)) continue;
        dllByFilename[fname] = dll; // later packages can overwrite with newer version
    }
}

var dllPaths = dllByFilename.Values.ToList();
Console.Error.WriteLine($"[TypeExtractor] found {dllPaths.Count} DLLs");

// ── Assembly resolver — let cross-Infragistics references work ────────────────

AppDomain.CurrentDomain.AssemblyResolve += (_, e) => {
    var simpleName = new AssemblyName(e.Name!).Name ?? "";
    // Try to find the dll in our package set
    if (dllByFilename.TryGetValue(simpleName + ".dll", out var path))
        return TryLoad(path);
    return null;
};

// ── Load assemblies ───────────────────────────────────────────────────────────

var loaded = new List<Assembly>();
foreach (var dll in dllPaths) {
    var asm = TryLoad(dll);
    if (asm != null) loaded.Add(asm);
}
Console.Error.WriteLine($"[TypeExtractor] loaded {loaded.Count} assemblies");

if (loaded.Count == 0) {
    Console.Error.WriteLine($"[TypeExtractor] ERROR: 0 assemblies loaded from {dllPaths.Count} candidate DLL(s) in {packagesDir}");
    Console.Error.WriteLine("This means the restore did not actually populate usable Infragistics.WPF.* packages (wrong feed, version mismatch, or a partial/failed restore).");
    Console.Error.WriteLine("Check nuget/WpfDocs.csproj and your NuGet source config, then re-run: npm run docs:restore");
    return 1;
}

// ── Phase 1: collect full→short name map and enum type set ───────────────────

// fullName → shortName (simple class name without namespace)
var knownTypes  = new Dictionary<string, string>(StringComparer.Ordinal);
// fullName of every enum type we find
var enumSet = new HashSet<string>(StringComparer.Ordinal);

foreach (var asm in loaded) {
    foreach (var t in SafeGetTypes(asm)) {
        if (!IsInfragisticsPublic(t)) continue;
        knownTypes[t.FullName!] = t.Name;
        if (t.IsEnum) enumSet.Add(t.FullName!);
    }
}

Console.Error.WriteLine($"[TypeExtractor] phase 1: {knownTypes.Count} types, {enumSet.Count} enums");

// ── Phase 2: emit type-info.json entries ─────────────────────────────────────

// Use a plain Dictionary<string, object?> — JsonSerializer serialises this cleanly
var output = new SortedDictionary<string, object?>(StringComparer.Ordinal);
var baseTypes = new SortedDictionary<string, string>(StringComparer.Ordinal);
var nonPublicMembers = new SortedSet<string>(StringComparer.Ordinal);

foreach (var asm in loaded) {
    foreach (var t in SafeGetTypes(asm)) {
        var topLevel = IsInfragisticsPublic(t);
        // IsVisible walks IsNested, which throws for types of the .NET Framework-only Exchange connector DLL.
        bool nestedPublic;
        try { nestedPublic = !topLevel && t.IsVisible && t.FullName!.StartsWith("Infragistics.", StringComparison.Ordinal); }
        catch { nestedPublic = false; }
        if (!topLevel && !nestedPublic) continue;

        // Member entries are keyed by assembly + full name like the maps below (nested types in the XML docs' form,
        // "…|Namespace.Outer.Inner"): with a short-name key, same-named types overwrote each other's entries
        // (the XGrid FilterOperand's Icon, a String, replaced the XamGrid one's DataTemplate).
        var typeKey = $"{asm.GetName().Name}|{t.FullName!.Replace('+', '.')}";

        // ── Members no app can use: internal, private, private protected ─────
        // The XML docs document those too (ValueEditor.InternalIsInitialized, the XamDockManager.FlyoutOpening event).
        // A name is listed only when no member of that name declared here is public or protected, so an overload set
        // with one usable method stays. Explicit interface implementations ("IList.Add") are left to build-api's '#' rule.
        // Nested public types too (DataPresenterBase.SelectedItemHolder.InternalClearSelection); the rest is top-level only.
        try {
            var usable = new Dictionary<string, bool>(StringComparer.Ordinal);
            void Note(string name, bool ok) {
                if (!name.Contains('.') && !name.StartsWith('<')) usable[name] = usable.GetValueOrDefault(name) || ok;
            }
            const BindingFlags declared = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance |
                                          BindingFlags.Static | BindingFlags.DeclaredOnly;
            foreach (var p in t.GetProperties(declared)) Note(p.Name, IsUsable(p.GetMethod) || IsUsable(p.SetMethod));
            foreach (var e in t.GetEvents(declared)) Note(e.Name, IsUsable(e.AddMethod));
            foreach (var m in t.GetMethods(declared)) if (!m.IsSpecialName) Note(m.Name, IsUsable(m));
            foreach (var (name, ok) in usable) if (!ok) nonPublicMembers.Add($"{typeKey}.{name}");
        } catch { /* skip inaccessible type: its members stay */ }

        if (!topLevel) continue;

        // ── Base type (only emit when the base is also an Infragistics type) ──
        // A generic base such as DataPresenterResourceSet<Locator> has a FullName with type arguments;
        // its definition is the known type, and Name ("DataPresenterResourceSet`1") matches build-api's key.
        // Keyed by assembly + full name: 72 short names are shared by types with different bases
        // (the chart Axis and the Excel Axis), and a short-name key let one overwrite the other.
        try {
            var bt = t.BaseType;
            var btDef = bt is { IsGenericType: true } ? bt.GetGenericTypeDefinition() : bt;
            if (btDef?.FullName != null && knownTypes.ContainsKey(btDef.FullName))
                baseTypes[typeKey] = $"{btDef.Assembly.GetName().Name}|{btDef.FullName}";
        } catch { /* skip */ }

        // ── Properties (DeclaredOnly so we don't duplicate inherited ones) ────
        // Static ones too: theme classes expose their styles as static properties (DataPresenterResourceSet`1.CellValuePresenter).
        try {
            var props = t.GetProperties(
                BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly);

            foreach (var prop in props) {
                try {
                    var entry = BuildPropertyEntry(prop.PropertyType);
                    output[$"{typeKey}.{prop.Name}"] = entry;
                } catch { /* skip unparseable property */ }
            }
        } catch { /* skip inaccessible type */ }

        // ── Static key and command fields, used in XAML via {x:Static} ────────
        // (style/brush keys such as DockManagerBrushKeys.*, commands such as DataPresenterCommands.*).
        // DependencyProperty and RoutedEvent fields are left out: their property/event is documented already.
        if (t.IsEnum) continue;
        try {
            foreach (var field in t.GetFields(BindingFlags.Public | BindingFlags.Static | BindingFlags.DeclaredOnly)) {
                if (!typeof(System.Windows.ResourceKey).IsAssignableFrom(field.FieldType) &&
                    !typeof(System.Windows.Input.RoutedCommand).IsAssignableFrom(field.FieldType)) continue;
                var entry = BuildPropertyEntry(field.FieldType);
                entry["isField"] = true;
                output[$"{typeKey}.{field.Name}"] = entry;
            }
        } catch { /* skip inaccessible type */ }
    }
}

output["__baseTypes"] = baseTypes;
output["__nonPublicMembers"] = nonPublicMembers;
Console.Error.WriteLine($"[TypeExtractor] phase 2: {output.Count} entries, {baseTypes.Count} base types, {nonPublicMembers.Count} non-public members");

// ── Non-public types ─────────────────────────────────────────────────────────
// The XML docs also document internal and private nested classes (ActivePaneManager, XamFunnelController, …),
// which no app can use. Only types reflection positively sees as non-public are listed — a type that can't be
// loaded (e.g. a .NET Framework-only DLL) is not, so a load failure can never hide public API.
var nonPublicTypes = new SortedSet<string>(StringComparer.Ordinal);
foreach (var asm in loaded) {
    Type?[] all;
    try { all = asm.GetTypes(); } catch (ReflectionTypeLoadException ex) { all = ex.Types; } catch { continue; }
    foreach (var t in all) {
        if (t?.FullName == null || t.IsVisible || !t.FullName.StartsWith("Infragistics.", StringComparison.Ordinal)) continue;
        nonPublicTypes.Add($"{asm.GetName().Name}|{t.FullName.Replace('+', '.')}");
    }
}
output["__nonPublicTypes"] = nonPublicTypes;
Console.Error.WriteLine($"[TypeExtractor] non-public types: {nonPublicTypes.Count}");

// ── Phase 3: the XAML namespace of every public type ─────────────────────────
// Resolved with System.Xaml's XamlSchemaContext — the XmlnsDefinition rules the WPF markup compiler applies — so
// a type only gets an xmlns that resolves to exactly that type, not a same-named one in another namespace or DLL.
// Several xmlns can map one CLR namespace; the most specific wins (http://infragistics.com/Themes over the
// catch-all http://schemas.infragistics.com/xaml/wpf). Types no Infragistics xmlns reaches get clr-namespace syntax.

var xmlnsDefs = new List<(string Xmlns, string Ns, string Asm)>();
var officialPrefixes = new Dictionary<string, string>(StringComparer.Ordinal);
foreach (var asm in loaded) {
    IList<CustomAttributeData> attrs;
    try { attrs = asm.GetCustomAttributesData(); } catch { continue; }
    foreach (var a in attrs) {
        if (a.AttributeType.FullName == "System.Windows.Markup.XmlnsDefinitionAttribute") {
            // AssemblyName lets one assembly map an xmlns onto types in another.
            var target = a.NamedArguments.FirstOrDefault(n => n.MemberName == "AssemblyName").TypedValue.Value as string
                         ?? asm.GetName().Name!;
            xmlnsDefs.Add(((string)a.ConstructorArguments[0].Value!, (string)a.ConstructorArguments[1].Value!, target));
        } else if (a.AttributeType.FullName == "System.Windows.Markup.XmlnsPrefixAttribute") {
            officialPrefixes[(string)a.ConstructorArguments[0].Value!] = (string)a.ConstructorArguments[1].Value!;
        }
    }
}
var namespacesPerXmlns = xmlnsDefs.GroupBy(d => d.Xmlns).ToDictionary(g => g.Key, g => g.Select(d => d.Ns).Distinct().Count());
// A DLL whose Infragistics references aren't in the set (a .NET Framework-only package referencing InfragisticsWPF)
// makes XamlSchemaContext throw for every xmlns lookup, so it is left out; its types fall back to clr-namespace.
var xamlAssemblies = loaded.Where(a => a.GetReferencedAssemblies()
    .Where(r => r.Name!.StartsWith("Infragistics", StringComparison.OrdinalIgnoreCase))
    .All(r => dllByFilename.ContainsKey(r.Name + ".dll"))).ToList();
foreach (var a in loaded.Except(xamlAssemblies))
    Console.Error.WriteLine($"[TypeExtractor] phase 3: {a.GetName().Name} left out of XAML resolution (references an Infragistics assembly not in the set)");
var xamlContext = new System.Xaml.XamlSchemaContext(xamlAssemblies);

bool ResolvesTo(string xmlns, string xamlName, Type t) {
    try { return xamlContext.GetXamlType(new System.Xaml.Schema.XamlTypeName(xmlns, xamlName))?.UnderlyingType == t; }
    catch { return false; }
}

// XamlSchemaContext ignores internal types and settles same-named public ones by assembly order, but the WPF markup
// compiler does neither: XamDataTree's public NodesManager under http://schemas.infragistics.com/xaml fails with
// MC3064 because XamDiagram has an internal NodesManager under the same xmlns, and the RichTextEditor/SyntaxEditor
// twins depend on which package the app references. So an xmlns is only used if no other top-level type of that name,
// public or not, lives in a namespace it covers; otherwise the type gets clr-namespace syntax, which names its assembly.
var coveredBy = xmlnsDefs.GroupBy(d => d.Xmlns).ToDictionary(
    g => g.Key, g => g.Select(d => (Asm: d.Asm.ToLowerInvariant(), d.Ns)).ToHashSet());
// Same assemblies as the resolution above: a type of the left-out .NET Framework-only DLL can't even report IsNested.
var topLevelByName = xamlAssemblies
    .SelectMany(a => { try { return a.GetTypes(); } catch (ReflectionTypeLoadException ex) { return ex.Types.OfType<Type>().ToArray(); } catch { return []; } })
    .Select(x => { try { return x.IsNested || x.FullName?.StartsWith("Infragistics.", StringComparison.Ordinal) != true ? null : x; } catch { return null; } })
    .OfType<Type>()
    .GroupBy(x => x.Name).ToDictionary(g => g.Key, g => g.Select(x => (Asm: x.Assembly.GetName().Name!.ToLowerInvariant(), Ns: x.Namespace ?? "")).ToList());
bool HasRival(string xmlns, string name, string asmName, string ns) =>
    topLevelByName.TryGetValue(name, out var same) &&
    same.Any(x => !(x.Asm == asmName.ToLowerInvariant() && x.Ns == ns) && coveredBy[xmlns].Contains(x));

var xamlTypes = new List<(string Key, string Ns, string Asm, string XamlName, string Xmlns, bool IsClr)>();
var unresolved = 0;
foreach (var asm in xamlAssemblies) {
    var asmName = asm.GetName().Name!;
    foreach (var t in SafeGetTypes(asm)) {
        if (!t.IsVisible || t.ContainsGenericParameters || t.FullName == null ||
            !t.FullName.StartsWith("Infragistics.", StringComparison.Ordinal)) continue;
        var ns = t.Namespace ?? "";
        // Nested types are named Outer+Inner in XAML; the XML docs call them Namespace.Outer.Inner.
        var xamlName = t.Name;
        for (var outer = t.DeclaringType; outer != null; outer = outer.DeclaringType) xamlName = $"{outer.Name}+{xamlName}";

        var xmlns = xmlnsDefs
            .Where(d => d.Ns == ns && string.Equals(d.Asm, asmName, StringComparison.OrdinalIgnoreCase))
            .Select(d => d.Xmlns).Distinct()
            .OrderBy(x => namespacesPerXmlns[x]).ThenBy(x => x, StringComparer.Ordinal)
            .FirstOrDefault(x => ResolvesTo(x, xamlName, t) && !HasRival(x, xamlName.Split('+')[0], asmName, ns));
        var isClr = xmlns == null;
        xmlns ??= $"clr-namespace:{ns};assembly={asmName}";
        if (isClr && !ResolvesTo(xmlns, xamlName, t)) { unresolved++; continue; }
        // Keyed by assembly too: the same Namespace.Type can exist in two DLLs (Caret in RichTextEditor and SyntaxEditor).
        xamlTypes.Add(($"{asmName}|{ns}.{xamlName.Replace('+', '.')}", ns, asmName, xamlName, xmlns, isClr));
    }
}

// Prefixes, one per xmlns: the DLLs' own XmlnsPrefix (igDP, igThemes, …), else "ig" + the xmlns' last path segment.
// A clr-namespace gets "ig" + the shortest tail of its namespace that is unique and doesn't clash with those
// (igCalculationStrategies); when one namespace spans several DLLs, the DLL's last name segment is added
// (igControlsEditorsXamSyntaxEditor), and a counter is the last resort.
string Cap(string s) => s.Length == 0 ? s : char.ToUpperInvariant(s[0]) + s[1..];
string XmlnsPrefix(string xmlns) => officialPrefixes.TryGetValue(xmlns, out var p) ? p : "ig" + Cap(xmlns.TrimEnd('/').Split('/').Last());
var reserved = xamlTypes.Where(x => !x.IsClr).Select(x => XmlnsPrefix(x.Xmlns)).ToHashSet(StringComparer.Ordinal);
var clr = xamlTypes.Where(x => x.IsClr).GroupBy(x => x.Xmlns).ToDictionary(g => g.Key, g => (
    Segments: g.First().Ns.Split('.').Skip(g.First().Ns.StartsWith("Infragistics", StringComparison.Ordinal) ? 1 : 0).Select(Cap).ToArray(),
    AsmSegment: Cap(g.First().Asm.Split('.').Last())));
var depth = clr.Keys.ToDictionary(k => k, _ => 1);
var withAsm = new HashSet<string>(StringComparer.Ordinal);
string ClrPrefix(string xmlns) {
    var (segments, asmSegment) = clr[xmlns];
    var tail = string.Concat(segments.TakeLast(depth[xmlns]));
    return "ig" + (tail.Length > 0 ? tail : "Infragistics") + (withAsm.Contains(xmlns) ? asmSegment : "");
}
for (var changed = true; changed;) {
    changed = false;
    foreach (var group in clr.Keys.GroupBy(ClrPrefix).Where(g => g.Count() > 1 || reserved.Contains(g.Key)).ToList())
        foreach (var xmlns in group) {
            if (depth[xmlns] < clr[xmlns].Segments.Length) depth[xmlns]++;
            else if (!withAsm.Add(xmlns)) continue;
            changed = true;
        }
}
var clrPrefixes = clr.Keys.GroupBy(ClrPrefix).SelectMany(g => g.OrderBy(x => x, StringComparer.Ordinal)
        .Select((xmlns, i) => (xmlns, prefix: g.Count() == 1 && !reserved.Contains(g.Key) ? g.Key : $"{g.Key}{i + 1}")))
    .ToDictionary(x => x.xmlns, x => x.prefix);

var xamlOut = new SortedDictionary<string, object>(StringComparer.Ordinal);
foreach (var x in xamlTypes) {
    var info = new Dictionary<string, object> {
        ["xmlns"] = x.Xmlns,
        ["prefix"] = x.IsClr ? clrPrefixes[x.Xmlns] : XmlnsPrefix(x.Xmlns),
        ["ns"] = x.Ns,
    };
    if (x.XamlName.Contains('+')) info["xamlName"] = x.XamlName;
    xamlOut[x.Key] = info;
}
output["__xaml"] = xamlOut;
Console.Error.WriteLine($"[TypeExtractor] phase 3: {xamlOut.Count} XAML namespaces ({xamlTypes.Count(x => x.IsClr)} clr-namespace, {unresolved} unresolvable)");

// ── Write JSON ────────────────────────────────────────────────────────────────

Directory.CreateDirectory(Path.GetDirectoryName(outputFile)!);
var json = JsonSerializer.Serialize(output);
File.WriteAllText(outputFile, json);

Console.WriteLine($"[TypeExtractor] wrote {output.Count} entries → {outputFile}");
return 0;

// ── Helpers ───────────────────────────────────────────────────────────────────

Dictionary<string, object?> BuildPropertyEntry(Type propType) {
    // Unwrap Nullable<T>
    var underlying = Nullable.GetUnderlyingType(propType);
    var isNullable  = underlying != null;
    var effectiveType = underlying ?? propType;

    // For generic types like IEnumerable<MarkerType>, check first type arg
    Type? enumType = null;
    if (effectiveType.IsEnum) {
        enumType = effectiveType;
    } else if (effectiveType.IsGenericType) {
        enumType = effectiveType.GetGenericArguments().FirstOrDefault(a => a.IsEnum);
    }

    var typeName = GetFriendlyName(effectiveType);
    var isEnum   = enumType != null;

    var entry = new Dictionary<string, object?> {
        ["typeName"]   = typeName,
        ["isNullable"] = isNullable,
        ["isEnum"]     = isEnum,
    };

    if (isEnum && enumType != null) {
        try { entry["enumValues"] = Enum.GetNames(enumType); }
        catch { /* enum may be unavailable */ }
    }

    return entry;
}

static string GetFriendlyName(Type t) {
    if (t.IsGenericType) {
        // Strip the `N arity suffix, e.g. "IEnumerable`1" → "IEnumerable"
        var baseName = t.Name.Split('`')[0];
        var args = string.Join(", ", t.GetGenericArguments().Select(GetFriendlyName));
        return $"{baseName}<{args}>";
    }
    return t.Name;
}

static bool IsInfragisticsDll(string filename) {
    return (filename.StartsWith("InfragisticsWPF.", StringComparison.OrdinalIgnoreCase) ||
            filename.StartsWith("Infragistics.WPF.", StringComparison.OrdinalIgnoreCase) ||
            filename.StartsWith("Infragistics4.", StringComparison.OrdinalIgnoreCase)) &&
           !filename.Contains(".Design.", StringComparison.OrdinalIgnoreCase) &&
           !filename.Contains(".resources.", StringComparison.OrdinalIgnoreCase);
}

// Callable from an app: public, or protected (from a subclass). Not internal, private or private protected.
static bool IsUsable(MethodBase? m) => m != null && (m.IsPublic || m.IsFamily || m.IsFamilyOrAssembly);

static bool IsInfragisticsPublic(Type t) =>
    t.IsPublic &&
    t.FullName != null &&
    t.FullName.StartsWith("Infragistics.", StringComparison.Ordinal) &&
    !t.FullName.Contains('+');   // skip nested types

static IEnumerable<Type> SafeGetTypes(Assembly asm) {
    try {
        return asm.GetExportedTypes();
    } catch (ReflectionTypeLoadException ex) {
        // Return whatever was loadable
        return ex.Types.Where(t => t != null)!;
    } catch {
        return [];
    }
}

static Assembly? TryLoad(string path) {
    try { return Assembly.LoadFrom(path); }
    catch (Exception ex) {
        Console.Error.WriteLine($"  SKIP {Path.GetFileName(path)}: {ex.Message}");
        return null;
    }
}

static string FindRoot(string start) {
    var dir = start;
    while (dir != null) {
        if (File.Exists(Path.Combine(dir, "package.json"))) return dir;
        dir = Path.GetDirectoryName(dir);
    }
    return start;
}
