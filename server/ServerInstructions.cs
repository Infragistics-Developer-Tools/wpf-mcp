namespace Infragistics.Wpf.Mcp;

// Verbatim copy of the `instructions` string in src/index.ts — keep both in sync.
public static class ServerInstructions
{
    public const string Text = """

              Infragistics NetAdvantage for WPF MCP server — component registry, API reference, documentation search, and project scaffolding.

              Canonical workflow — these tools form one chain, follow it in order and reuse the exact names between steps, don't skip ahead to writing XAML:
                1. Resolve the component name: list_wpf_components (Xam* control you can name or want to browse) or search_wpf_api (only know a feature/keyword, e.g. "filter", "export").
                2. get_wpf_api_reference(component) using that exact name for the authoritative member list. If sparse, it names a base type — call it again on that base type.
                3. Whenever the task needs HOW-TO guidance beyond "what members exist" — layouts/nesting, styling/theming, data binding, editing/validation, filtering/sorting/grouping/summaries, exporting, performance, commands, known issues, etc. — call search_wpf_docs(query, control: component), passing the SAME component name from step 1/2 to scope the search.
                4. get_wpf_doc(slug) on the most relevant result from step 3 to read the full XAML example or how-to text before writing any code or giving usage advice.
                5. For new projects, get_wpf_project_scaffold(components) after step 1 for dotnet CLI + xmlns setup, then still run steps 2-4 per component before writing real XAML.
                6. Establish the visual theme EARLY — treat it as a default step for any new window/app, not an optional afterthought. Call setup_wpf_theme(component?, theme?) to pick a named theme and get the exact ready-to-paste apply steps (NuGet package + App.xaml.cs ThemeManager call for the newer family, or Theme="<Name>" for the legacy family) plus the resource file paths; then get_wpf_theme_resource(path) only if you need to copy/override a specific Style/ControlTemplate. When the goal is to RE-COLOR an existing theme (change its palette) rather than restyle one control, call get_wpf_theme_palette(theme) for that theme's centralized color/brush keys and a ready-to-merge override skeleton.

              ALWAYS call list_wpf_components/search_wpf_api before writing any XAML to get the correct xmlns namespace URI; wrong values cause immediate compile errors.
              ALWAYS establish a theme via setup_wpf_theme (then get_wpf_theme_palette to recolor if needed) BEFORE writing any Style, Setter, Brush, or color attribute on an Infragistics control. Do NOT hand-author a color scheme (dark, neon, corporate, etc.) to approximate a look — a named theme or palette override is the correct, lower-maintenance path.
              Never guess property names, child-element nesting, or other usage details (styling, data binding, performance, etc.) — verify through this chain rather than assuming from a similar control or from naming conventions.

        """;
}
