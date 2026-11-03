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
 *   "__members"                 : { "Assembly|<XML doc ID>" : { sig?, obsolete?, hidden? } }
 *                                 (every public / protected method and constructor, with its C# signature; properties,
 *                                 events, fields and the type itself only when they are indexers or marked obsolete / hidden)
 *   "__memberTypes"             : [ "Assembly|Namespace.Type", … ]   (types whose members "__members" covers)
 */

using System;
using System.Collections.Generic;
using System.Globalization;
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
var members = new SortedDictionary<string, Dictionary<string, object>>(StringComparer.Ordinal);
var memberTypes = new SortedSet<string>(StringComparer.Ordinal);

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

        // ── Signatures and flags, keyed by XML doc ID ───────────────────────
        // The XML docs name a member by its doc ID ("M:Namespace.Type.Load(System.String,System.Boolean)"), which
        // also tells overloads apart. Reflection adds what the ID can't: return type, parameter names, out vs ref,
        // defaults. Every public / protected method and constructor gets an entry, so an overload without one is not
        // usable; properties, events and fields only when they are indexers or marked [Obsolete] / hidden from
        // IntelliSense. A type that throws here stays out of "__memberTypes", and build-api keeps its members as before.
        try {
            const BindingFlags declared = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance |
                                          BindingFlags.Static | BindingFlags.DeclaredOnly;
            var asmName = asm.GetName().Name;
            var typeId = DocTypeId(t);
            void Add(string docId, MemberInfo m, string? sig) {
                try {
                    var entry = MemberEntry(m, sig);
                    if (entry.Count > 0) members[$"{asmName}|{docId}"] = entry;
                } catch { /* unreadable attributes or signature: the member stays name-only */ }
            }
            var methods = new List<(string Id, MethodBase M, string Sig)>();
            foreach (var m in t.GetMethods(declared).Cast<MethodBase>().Concat(t.GetConstructors(declared))) {
                if (!IsUsable(m) || (m is ConstructorInfo && m.IsStatic)) continue;
                // Property / event accessors and explicit interface implementations ("IList.Add") aren't called by name.
                if (m is MethodInfo && (m.Name.Contains('.') || (m.IsSpecialName && !m.Name.StartsWith("op_", StringComparison.Ordinal)))) continue;
                try { methods.Add((MethodDocId(typeId, m), m, MethodSignature(m))); } catch { /* unreadable signature: name-only */ }
            }
            // Overloads that differ only in a type's namespace (WorkbookColorInfo(System.Drawing.Color) and
            // (System.Windows.Media.Color)) would read the same: those spell their types in full.
            var ambiguous = methods.GroupBy(x => x.Sig).Where(g => g.Count() > 1).SelectMany(g => g).Select(x => x.Id).ToHashSet();
            foreach (var (id, m, sig) in methods) {
                string full;
                try { full = ambiguous.Contains(id) ? MethodSignature(m, qualified: true) : sig; } catch { full = sig; }
                Add(id, m, full);
            }
            foreach (var p in t.GetProperties(declared)) {
                if (!(IsUsable(p.GetMethod) || IsUsable(p.SetMethod)) || p.Name.Contains('.')) continue;
                var index = p.GetIndexParameters();
                var id = $"P:{typeId}.{p.Name}" + (index.Length > 0 ? $"({string.Join(",", index.Select(x => ParamId(x.ParameterType)))})" : "");
                Add(id, p, index.Length > 0 ? IndexerSignature(p, index) : null);
            }
            foreach (var e in t.GetEvents(declared)) if (IsUsable(e.AddMethod) && !e.Name.Contains('.')) Add($"E:{typeId}.{e.Name}", e, null);
            foreach (var f in t.GetFields(BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly))
                Add($"F:{typeId}.{f.Name}", f, null);
            Add($"T:{typeId}", t, null);   // the type itself, when it is [Obsolete] (UnboundField) or hidden
            memberTypes.Add(typeKey);
        } catch { /* skip inaccessible type: build-api keeps its members name-only */ }

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
output["__members"] = members;
output["__memberTypes"] = memberTypes;
Console.Error.WriteLine($"[TypeExtractor] phase 2: {output.Count} entries, {baseTypes.Count} base types, {nonPublicMembers.Count} non-public members");
Console.Error.WriteLine($"[TypeExtractor] phase 2: {members.Count(m => m.Value.ContainsKey("sig"))} signatures, " +
    $"{members.Count(m => m.Value.ContainsKey("obsolete"))} obsolete, {members.Count(m => m.Value.ContainsKey("hidden"))} hidden members, " +
    $"{memberTypes.Count} types covered");

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

// ── XML doc IDs (the "name" attribute of each <member> in the XML docs) ──────

// A type in declaration form: Namespace.Outer`1.Inner
static string DocTypeId(Type t) =>
    t.IsNested ? $"{DocTypeId(t.DeclaringType!)}.{t.Name}" : (string.IsNullOrEmpty(t.Namespace) ? "" : t.Namespace + ".") + t.Name;

static string MethodDocId(string typeId, MethodBase m) {
    var id = $"M:{typeId}.{(m is ConstructorInfo ? "#ctor" : m.Name)}";
    if (m.IsGenericMethodDefinition) id += $"``{m.GetGenericArguments().Length}";
    var ps = m.GetParameters();
    if (ps.Length > 0) id += $"({string.Join(",", ps.Select(p => ParamId(p.ParameterType)))})";
    if (m.Name is "op_Implicit" or "op_Explicit") id += "~" + ParamId(((MethodInfo)m).ReturnType);
    return id;
}

// A type inside a doc ID's parameter list: generic types as Name{Arg,…} (also a generic type naming itself, which
// reflection returns as its definition), `N / ``N for the type's / method's generic parameters, @ by-ref, * pointer,
// [] and [0:,0:] arrays.
static string ParamId(Type t) {
    if (t.IsByRef) return ParamId(t.GetElementType()!) + "@";
    if (t.IsPointer) return ParamId(t.GetElementType()!) + "*";
    if (t.IsArray) return ParamId(t.GetElementType()!) + (t.IsSZArray ? "[]" : $"[{string.Join(",", Enumerable.Repeat("0:", t.GetArrayRank()))}]");
    if (t.IsGenericParameter) return (t.DeclaringMethod != null ? "``" : "`") + t.GenericParameterPosition;
    if (!t.IsGenericType) return DocTypeId(t);
    // Each nesting level names its own share of the arguments: Outer{`0}.Inner{`1}.
    var args = t.GetGenericArguments();
    var chain = new List<Type>();
    for (var x = t.IsGenericTypeDefinition ? t : t.GetGenericTypeDefinition(); x != null; x = x.IsNested ? x.DeclaringType : null) chain.Insert(0, x);
    var id = string.IsNullOrEmpty(chain[0].Namespace) ? "" : chain[0].Namespace + ".";
    var used = 0;
    for (var i = 0; i < chain.Count; i++) {
        var name = chain[i].Name;
        var tick = name.IndexOf('`');
        var own = tick < 0 ? 0 : int.Parse(name[(tick + 1)..], CultureInfo.InvariantCulture);
        id += (i > 0 ? "." : "") + (tick < 0 ? name : name[..tick]);
        if (own > 0) { id += "{" + string.Join(",", args.Skip(used).Take(own).Select(ParamId)) + "}"; used += own; }
    }
    return id;
}

// ── C# signatures, as an app would write the call ────────────────────────────

static Dictionary<string, object> MemberEntry(MemberInfo m, string? sig) {
    var entry = new Dictionary<string, object>();
    if (sig != null) entry["sig"] = sig;
    // Read as attribute data: constructing the attributes could fail for a type whose dependencies don't load.
    foreach (var a in m.GetCustomAttributesData()) {
        if (a.AttributeType.FullName == "System.ObsoleteAttribute")
            entry["obsolete"] = a.ConstructorArguments.Count > 0 ? a.ConstructorArguments[0].Value as string ?? "" : "";
        else if (a.AttributeType.FullName == "System.ComponentModel.EditorBrowsableAttribute" &&
                 a.ConstructorArguments.Count > 0 && Convert.ToInt32(a.ConstructorArguments[0].Value, CultureInfo.InvariantCulture) == 1)
            entry["hidden"] = true;   // EditorBrowsableState.Never
    }
    return entry;
}

static string MethodSignature(MethodBase m, bool qualified = false) {
    var modifiers = (m.IsPublic ? "" : "protected ") + (m.IsStatic ? "static " : "");
    var ps = FormatParameters(m.GetParameters(), m.IsDefined(typeof(System.Runtime.CompilerServices.ExtensionAttribute), false), qualified);
    if (m is ConstructorInfo) return $"{modifiers}{m.DeclaringType!.Name.Split('`')[0]}({ps})";
    var mi = (MethodInfo)m;
    var ret = TypeDisplayName(mi.ReturnType, qualified);
    if (mi.Name is "op_Implicit" or "op_Explicit") return $"{modifiers}{(mi.Name == "op_Implicit" ? "implicit" : "explicit")} operator {ret}({ps})";
    if (OperatorSymbol(mi.Name) is { } symbol) return $"{modifiers}{ret} operator {symbol}({ps})";
    var generic = mi.IsGenericMethodDefinition ? $"<{string.Join(", ", mi.GetGenericArguments().Select(a => a.Name))}>" : "";
    return $"{modifiers}{ret} {mi.Name}{generic}({ps})";
}

static string IndexerSignature(PropertyInfo p, ParameterInfo[] index) =>
    $"{(p.GetMethod?.IsPublic == true || p.SetMethod?.IsPublic == true ? "" : "protected ")}{TypeDisplayName(p.PropertyType)} this[{FormatParameters(index, false)}]";

static string FormatParameters(ParameterInfo[] ps, bool isExtension, bool qualified = false) => string.Join(", ", ps.Select((p, i) => {
    var modifier = i == 0 && isExtension ? "this " : "";
    if (p.ParameterType.IsByRef) modifier += p.IsOut ? "out " : p.IsIn ? "in " : "ref ";
    else if (p.IsDefined(typeof(ParamArrayAttribute), false)) modifier += "params ";
    var text = $"{modifier}{TypeDisplayName(p.ParameterType, qualified)} {p.Name ?? $"arg{i}"}";
    string? value = null;
    try { if (p.HasDefaultValue) value = FormatDefault(p); } catch { /* an unreadable default is left out */ }
    return value == null ? text : $"{text} = {value}";
}));

static string? FormatDefault(ParameterInfo p) {
    var v = p.DefaultValue;
    var type = Nullable.GetUnderlyingType(p.ParameterType) ?? p.ParameterType;
    if (v == null) return p.ParameterType.IsValueType && Nullable.GetUnderlyingType(p.ParameterType) == null ? "default" : "null";
    if (type.IsEnum) {
        var name = Enum.GetName(type, v);
        return name != null ? $"{TypeDisplayName(type)}.{name}" : $"({TypeDisplayName(type)}){Convert.ToInt64(v, CultureInfo.InvariantCulture)}";
    }
    return v switch {
        string s => $"\"{s.Replace("\\", "\\\\").Replace("\"", "\\\"")}\"",
        bool b => b ? "true" : "false",
        char c => $"'{c}'",
        IFormattable f => f.ToString(null, CultureInfo.InvariantCulture),
        _ => v.ToString(),
    };
}

// C# spelling of a type: keywords for built-ins, T? for Nullable<T>, Outer.Inner for nested types, no namespaces
// unless qualified.
static string TypeDisplayName(Type t, bool qualified = false) {
    if (t.IsByRef) return TypeDisplayName(t.GetElementType()!, qualified);
    if (t.IsPointer) return TypeDisplayName(t.GetElementType()!, qualified) + "*";
    if (t.IsArray) return $"{TypeDisplayName(t.GetElementType()!, qualified)}[{new string(',', t.GetArrayRank() - 1)}]";
    if (Nullable.GetUnderlyingType(t) is { } underlying) return TypeDisplayName(underlying, qualified) + "?";
    if (t.IsGenericParameter) return t.Name;
    var keyword = t.FullName switch {
        "System.String" => "string", "System.Boolean" => "bool", "System.Int32" => "int", "System.Int64" => "long",
        "System.Int16" => "short", "System.Byte" => "byte", "System.SByte" => "sbyte", "System.UInt16" => "ushort",
        "System.UInt32" => "uint", "System.UInt64" => "ulong", "System.Double" => "double", "System.Single" => "float",
        "System.Decimal" => "decimal", "System.Char" => "char", "System.Object" => "object", "System.Void" => "void",
        _ => null,
    };
    if (keyword != null) return keyword;
    static string Plain(Type x) => (x.IsNested ? Plain(x.DeclaringType!) + "." : "") + x.Name.Split('`')[0];
    var tick = t.Name.IndexOf('`');
    var own = tick < 0 ? 0 : int.Parse(t.Name[(tick + 1)..], CultureInfo.InvariantCulture);
    var args = own > 0 ? $"<{string.Join(", ", t.GetGenericArguments().TakeLast(own).Select(a => TypeDisplayName(a, qualified)))}>" : "";
    return (qualified && !string.IsNullOrEmpty(t.Namespace) ? t.Namespace + "." : "") + Plain(t) + args;
}

static string? OperatorSymbol(string name) => name switch {
    "op_Addition" => "+", "op_Subtraction" => "-", "op_Multiply" => "*", "op_Division" => "/", "op_Modulus" => "%",
    "op_Equality" => "==", "op_Inequality" => "!=", "op_LessThan" => "<", "op_GreaterThan" => ">",
    "op_LessThanOrEqual" => "<=", "op_GreaterThanOrEqual" => ">=", "op_UnaryNegation" => "-", "op_UnaryPlus" => "+",
    "op_LogicalNot" => "!", "op_OnesComplement" => "~", "op_Increment" => "++", "op_Decrement" => "--",
    "op_True" => "true", "op_False" => "false", "op_BitwiseAnd" => "&", "op_BitwiseOr" => "|", "op_ExclusiveOr" => "^",
    "op_LeftShift" => "<<", "op_RightShift" => ">>",
    _ => null,
};

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
