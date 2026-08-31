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
 *   "TypeShortName.__baseType"  : "BaseTypeShortName"          (only for Infragistics bases)
 *   "TypeShortName.PropName"    : { typeName, isNullable, isEnum, enumValues? }
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
    "net8.0-windows7.0", "net10.0-windows7.0", "net9.0-windows7.0",
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

foreach (var asm in loaded) {
    foreach (var t in SafeGetTypes(asm)) {
        if (!IsInfragisticsPublic(t)) continue;

        var shortName = t.Name;

        // ── Base type (only emit when the base is also an Infragistics type) ──
        try {
            var bt = t.BaseType;
            if (bt?.FullName != null && knownTypes.ContainsKey(bt.FullName))
                output[$"{shortName}.__baseType"] = bt.Name;
        } catch { /* skip */ }

        // ── Properties (DeclaredOnly so we don't duplicate inherited ones) ────
        try {
            var props = t.GetProperties(
                BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly);

            foreach (var prop in props) {
                try {
                    var entry = BuildPropertyEntry(prop.PropertyType);
                    output[$"{shortName}.{prop.Name}"] = entry;
                } catch { /* skip unparseable property */ }
            }
        } catch { /* skip inaccessible type */ }
    }
}

Console.Error.WriteLine($"[TypeExtractor] phase 2: {output.Count} entries");

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
