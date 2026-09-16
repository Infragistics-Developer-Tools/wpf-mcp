namespace Infragistics.Wpf.Mcp.Data;

public static class ThemeLookup
{
    // Mirrors isThemeableComponent() in src/tools/handlers.ts: a component is themeable
    // when a theme file actually styles it (targetTypes), or by folder/filename fallback.
    public static bool IsThemeable(string component, ThemeIndex index)
    {
        var name = component.ToLowerInvariant();
        var legacy = index.LegacyStyles.Any(s =>
            s.Folder.ToLowerInvariant() == name ||
            s.Files.Any(f => f.TargetTypes.Any(t => t.ToLowerInvariant() == name)));
        var newer = index.NewerThemes.Any(t =>
            t.Files.Any(f => f.File.ToLowerInvariant().Contains(name) || f.TargetTypes.Any(tt => tt.ToLowerInvariant() == name)));
        return legacy || newer;
    }
}
