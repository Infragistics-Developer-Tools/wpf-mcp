export const TOOL_DESCRIPTIONS = {
  list_wpf_components: `List Infragistics WPF controls with their canonical XAML namespace URI, recommended xmlns prefix, required NuGet package, and description.

Call this FIRST — before writing any XAML or selecting NuGet packages. Namespace URIs must be exact; wrong values cause immediate compile errors.

Returns one entry per component: name, xmlns URI, prefix, NuGet package, and description. Pass the name to get_wpf_api_reference for full API docs.`,

  get_wpf_api_reference: `Get full API documentation for an Infragistics WPF type: xmlns declaration, NuGet package, type summary, and all members (properties, methods, events) with descriptions.

Use after list_wpf_components to resolve the component name. Also use to check whether a specific property or event exists on a known type — it returns the complete member list.

Note: XamDataGrid inherits most of its surface (DataSource, FieldLayouts, FieldSettings, FieldLayoutSettings) from XamDataPresenter. If the member list is sparse, also call get_wpf_api_reference("XamDataPresenter").`,

  get_project_scaffold: `Generate dotnet CLI setup commands and XAML xmlns declarations for a new Infragistics WPF project.

Call this when a user wants to start a new WPF project. Pass component names resolved via list_wpf_components. Returns:
  • dotnet new, dotnet add package, and dotnet restore commands
  • xmlns declarations for MainWindow.xaml`,

  search_wpf_api: `Search Infragistics WPF API entries by keyword across type names, summaries, and member names.

Use when you don't know the exact type name or want to discover types related to a feature. Do NOT use to verify members on a known type — call get_wpf_api_reference instead, which returns the complete member list.

Examples: "filter", "DataSource", "export", "pivot".
Returns a ranked list of matching types — call get_wpf_api_reference on any result for full details.`,
};
