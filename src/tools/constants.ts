export const TOOL_DESCRIPTIONS = {
  list_wpf_components: `List all available Infragistics NetAdvantage for WPF controls with their canonical XAML namespace URI, recommended xmlns prefix, required NuGet package, and a description.

Call this FIRST — before writing any XAML or selecting NuGet packages. AI models frequently hallucinate Infragistics namespace URIs (e.g. inventing "http://infragistics.com/DataGrid" instead of the correct "http://infragistics.com/DataPresenter"), which causes immediate compile errors. This tool returns the canonical values from the component registry.

Optionally pass a filter keyword (e.g. "grid", "chart", "dock", "editor") to narrow results.

Returns a Markdown list. Each entry includes component name, complete xmlns declaration, NuGet package, assembly, and description.
// REPLACED_SENTINEL

Call this first — before writing any XAML or C# — to get the correct xmlns declaration for each control you plan to use. Wrong namespace URIs are the most common compile-time error when working with Infragistics WPF.

Returns one entry per component including:
  • component name (pass to get_wpf_api_reference for full API docs)
  • XAML namespace URI (use verbatim in xmlns declarations)
  • recommended prefix (e.g. igDP, igDock, ig)
  • NuGet package to install
  • short description of what the control does and when to use it

No parameters required. Returns all components in one call.`,

  get_wpf_api_reference: `Get API documentation for a specific Infragistics WPF component parsed from the installed NuGet XML documentation files.

Use this after calling list_wpf_components to resolve the exact component name. Do NOT guess component names — if unsure, call list_wpf_components first.

Returns:
  • Correct xmlns declaration to copy verbatim into XAML
  • NuGet package and assembly name
  • Type summary and remarks
  • Direct members (properties, methods, events) with descriptions

Important: XamDataGrid exposes most of its feature surface (DataSource, FieldLayouts, FieldSettings, FieldLayoutSettings, etc.) through its base class XamDataPresenter. If the returned member list is sparse for XamDataGrid, also call get_wpf_api_reference("XamDataPresenter") to get the full inherited property set.

Use kind="properties", "methods", or "events" to reduce response size when you only need one category. Defaults to "all".`,
};
