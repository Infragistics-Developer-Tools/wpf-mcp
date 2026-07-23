export const TOOL_DESCRIPTIONS = {
  list_wpf_components: `List all available Infragistics NetAdvantage for WPF controls with their canonical XAML namespace URI, recommended xmlns prefix, required NuGet package, and a description.

Call this FIRST — before writing any XAML or selecting NuGet packages. AI models frequently hallucinate Infragistics namespace URIs (e.g. inventing "http://infragistics.com/DataGrid" instead of the correct "http://infragistics.com/DataPresenter"), which causes immediate compile errors. This tool returns the canonical values from the component registry.

Optionally pass a filter keyword (e.g. "grid", "chart", "dock", "editor") to narrow results.

Returns one entry per component including:
  • component name (pass to get_wpf_api_reference for full API docs)
  • XAML namespace URI — use verbatim in xmlns declarations
  • recommended prefix (e.g. igDP, igDock, ig)
  • NuGet package to install
  • short description of what the control does`,

  get_wpf_api_reference: `Get API documentation for a specific Infragistics WPF component parsed from the installed NuGet XML documentation files.

Use this after calling list_wpf_components to resolve the exact component name. Do NOT guess component names — if unsure, call list_wpf_components first.

Returns:
  • Correct xmlns declaration to copy verbatim into XAML
  • NuGet package and assembly name
  • Type summary and remarks
  • Direct members (properties, methods, events) with descriptions

Important: XamDataGrid exposes most of its feature surface (DataSource, FieldLayouts, FieldSettings, FieldLayoutSettings, etc.) through its base class XamDataPresenter. If the returned member list is sparse for XamDataGrid, also call get_wpf_api_reference("XamDataPresenter") to get the full inherited property set.

Use kind="properties", "methods", or "events" to reduce response size when you only need one category. Defaults to "all".`,

  search_wpf_api: `Search Infragistics WPF API entries by keyword across type names, summaries, and member names.

Use this when you don't know the exact type name, or to discover which types relate to a feature. Returns a ranked list of matching types with their summaries and matched context — then call get_wpf_api_reference for full member details.

Examples:
  • "filter" → finds XamGrid filter types, FilterRecord, FilterOperand, etc.
  • "DataSource" → finds types that declare a DataSource member
  • "export" → finds DataPresenterExcelExporter, WordWriter, etc.
  • "pivot" → finds XamPivotGrid, OlapDataProvider, etc.

Returns up to 10 results by default (configurable up to 50), ranked: type name match first, then summary match, then member name match.`,
};
