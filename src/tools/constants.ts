export const TOOL_DESCRIPTIONS = {
  list_wpf_components: `List Infragistics WPF controls with their canonical XAML namespace URI, recommended xmlns prefix, required NuGet package, and description.

Call this FIRST when the user names (or is looking for) a Xam* control — before writing any XAML, selecting NuGet packages, or searching documentation. Namespace URIs must be exact; wrong values cause immediate compile errors.

Returns one entry per component: name, xmlns URI, prefix, NuGet package, and description. The exact \`component\` name returned is the key that chains into every other tool — reuse it verbatim:
  • get_wpf_api_reference(component) — full member list
  • search_wpf_docs(query, control: component) — how-to topics scoped to this control
  • get_project_scaffold(components: [component, ...]) — project setup

⚠️ The API reference alone often isn't enough to write correct XAML or give correct advice — required child-element nesting is only one example. Documentation also covers styling/theming, data binding, editing/validation, filtering/sorting/grouping/summaries, exporting, performance, and known issues/breaking changes. Before writing non-trivial XAML or advising on configuration for a control, call search_wpf_docs(query, control: component) for a relevant topic, then get_wpf_doc on the result. Skipping this is a common cause of structural errors, incorrect property usage, and outdated advice.`,

  get_wpf_api_reference: `Get full API documentation for an Infragistics WPF type: xmlns declaration, NuGet package, type summary, and all members (properties, methods, events) with descriptions.

Use after list_wpf_components (or search_wpf_api, if the exact type name isn't known yet) to resolve the component name. Also use to check whether a specific property or event exists on a known type — it returns the complete member list, including members inherited from Infragistics base classes.

If a type's own member list is unexpectedly sparse, the response names its base type — call get_wpf_api_reference again on that base type to see the rest of the inherited surface.

⚠️ Property names here are authoritative, but this tool only lists members — it does not show how properties combine in real XAML, which child elements a container accepts, or how to approach styling, data binding, editing, performance, or other usage concerns. Never guess a property name from what sounds plausible — look it up here first. Before writing non-trivial XAML or giving configuration/usage advice, pass the same component name to search_wpf_docs(query, control: component) to find a relevant topic then get_wpf_doc(slug) to read the full working example.`,

  get_project_scaffold: `Generate dotnet CLI setup commands and XAML xmlns declarations for a new Infragistics WPF project.

Call this when a user wants to start a new WPF project. Pass component names resolved via list_wpf_components. Returns:
  • dotnet new, dotnet add package, and dotnet restore commands
  • xmlns declarations for MainWindow.xaml

This only scaffolds the project shell — it does not tell you how to configure each control. Once the project exists, follow the normal chain per component (get_wpf_api_reference, then search_wpf_docs(control: component) + get_wpf_doc) before writing real XAML for it.`,

  search_wpf_api: `Search Infragistics WPF API entries by keyword across type names, summaries, and member names. Multi-word queries use ranked OR matching — a type matching more words ranks higher, but matching just one word still returns it, so a natural-language phrase won't come back empty.

Use when you don't know the exact type name or want to discover types related to a feature — e.g. the user describes a capability ("filter", "export", "pivot") rather than naming a control. Do NOT use to verify members on a known type — call get_wpf_api_reference instead, which returns the complete member list.

Returns a ranked list of matching types (name, summary, NuGet package). The \`typeName\` of any result is the key that chains forward — reuse it verbatim in get_wpf_api_reference(component) for full members, or in search_wpf_docs(query, control: typeName) for how-to topics.`,

  search_wpf_docs: `Search Infragistics WPF how-to and conceptual documentation (2,600+ topics from the official docs-wpf and docs-common repositories) by keyword and/or control name — this is the FULL documentation set, covering far more than child-element nesting: getting started, layouts, styling/theming, data binding, editing/validation, filtering/sorting/grouping/summaries, exporting, performance, commands, persistence, known issues, and breaking changes.

Use this whenever a task goes beyond "what members exist on this type" — i.e. whenever you need to know HOW to accomplish something with a control (any non-trivial XAML, behavior, styling, or configuration), not only when the control nests child content. Pass the exact component name already resolved via list_wpf_components / search_wpf_api / get_wpf_api_reference as \`control\` to scope results to that component instead of searching all 2,600+ topics blind.

\`query\` uses ranked OR matching — a topic matching more words ranks higher, but matching just one word still returns it, so prefer 2-4 specific words over a full sentence (a full sentence still works, it's just less precise). \`query\` is optional: pass \`control\` alone to browse every topic for that component.

Returns a ranked list of matching topics with slug, title, controls, tags, and a short summary — NOT the full content. This is a lookup step, not the final answer: always follow up with get_wpf_doc(slug) on the most relevant result(s) before writing any code or giving usage advice.`,

  get_wpf_doc: `Retrieve the full text and extracted XAML code examples for one WPF documentation topic — any topic type: getting started, layouts/nesting, styling/theming, data binding, editing/validation, filtering/sorting/grouping/summaries, exporting, performance, commands, persistence, known issues, breaking changes, etc. Not limited to structural/nesting topics.

Use the exact slug returned by search_wpf_docs — this is always the last step of the discovery chain (list_wpf_components/search_wpf_api → get_wpf_api_reference → search_wpf_docs → get_wpf_doc), never the first call in a session. Returns the topic title, associated control names, tags, up to 6 XAML code samples (verified working examples from Infragistics' official docs), and the full descriptive body text.

Call this before writing XAML or giving configuration/usage advice for any control whose behavior isn't already confirmed by an existing working example — this is the most effective way to avoid build errors from guessed property names, runtime errors from invalid nesting, and incorrect advice on styling, data binding, performance, or any other topic covered by the docs.`,

  list_wpf_themes: `List available Infragistics WPF named themes and the raw XAML style/resource-dictionary files backing them, sourced directly from the official Infragistics/wpf-resources repository. Covers BOTH theming mechanisms used across the product — they are NOT interchangeable, always check which one applies before writing code:

  1. Legacy "Infragistics.Windows.*" family (XamDataGrid/XamDataPresenter, XamRibbon, XamDockManager, XamTabControl, etc.) — named themes (MetroDark, RoyalDark, Office2013, ...) ship embedded as BAML **inside the component's own assembly**. Apply out-of-the-box by simply setting \`Theme="MetroDark"\` on the control — no package or merge needed. The matching files under \`DefaultStyles/{Folder}/\` are for *customizing*: copy the relevant Style/ControlTemplate and override just what you need.
  2. Newer "Infragistics.Controls.*" family (charts, gauges, and other newer controls) — themes are NOT embedded; apply via a separate \`Infragistics.WPF.Themes.<Name>.Trial\` NuGet package plus \`Infragistics.Themes.ThemeManager.ApplicationTheme = new <Name>Theme();\` in App.xaml.cs (do NOT manually merge the \`Themes/{ThemeName}/\` files into Application.Resources — that throws a runtime XamlParseException). The matching files under \`Themes/{ThemeName}/\` are for inspecting/customizing the exact brushes and templates that theme applies.

Call this FIRST for any styling/theming task — before writing XAML, before advising which mechanism applies, and before calling get_wpf_theme_resource. Pass \`component\` and/or \`theme\` to filter; omit both to see the full list of theme names and legacy style folders. Returns exact \`path\` values — reuse them verbatim in get_wpf_theme_resource(path) to read the actual XAML content.`,

  get_wpf_theme_resource: `Retrieve the full raw XAML content of one theme/style resource-dictionary file from the official Infragistics/wpf-resources repository — real Style/ControlTemplate/brush definitions, not summarized.

Use the exact \`path\` returned by list_wpf_themes (e.g. "Themes/MetroDark/MetroDark.xamDataChart.xaml" or "DefaultStyles/Ribbon/RibbonMetroDark.xaml") — never guess this path. This is always the second step after list_wpf_themes, never the first call.

Use this when the user wants to customize/override part of a control's themed appearance (copy the real Style/ControlTemplate as a starting point instead of guessing property names or template structure), or wants to see exactly what a named theme changes for a given control. Large files are truncated with a note — ask for a narrower/more specific file via list_wpf_themes if you need a part that got cut off.`,
};

