import { z } from 'zod';

export const listComponentsSchema = {
  filter: z
    .string()
    .optional()
    .describe(`Optional keyword to filter by component name, description, or NuGet package.
      Case-insensitive. Examples: "grid", "chart", "dock", "editor". Omit to return all.`),
};

export const getApiReferenceSchema = {
  component: z
    .string()
    .min(1, 'Component name is required.')
    .max(128)
    .describe(`Any Infragistics WPF type name — 7000+ types including controls (e.g. "XamDataGrid"),
      supporting types (e.g. "FieldLayout", "SummaryDefinition"), enums, strategies, indicators, and more.
      Case-insensitive. To find a Xam* control name use list_wpf_components. To discover any other type name use search_wpf_api.`),
  kind: z
    .enum(['all', 'properties', 'methods', 'events'])
    .default('all')
    .describe(`Member category to return. Defaults to "all". Use a specific category when the user asks only about properties, methods, or events.`),
};

export const searchApiSchema = {
  query: z
    .string()
    .min(1)
    .max(128)
    .describe(`Keyword or phrase to search across type names, summaries, and member names.
      Case-insensitive. Multiple words use AND logic — every word must appear somewhere in the same type.
      Examples: "filter", "DataSource", "FieldSettings AllowEdit", "XamDataGrid sort".`),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe(`Maximum number of results to return. Defaults to 10, max 50.`),
};

export const getProjectScaffoldSchema = {
  components: z
    .array(z.string())
    .min(1)
    .describe(`List of Infragistics WPF component names to include in the project.
      Call list_wpf_components first to resolve exact names.
      Examples: ["XamDataGrid", "XamCategoryChart"], ["XamDockManager"].`),
  projectName: z
    .string()
    .min(1)
    .max(128)
    .default('MyWpfApp')
    .describe(`.NET project name. Defaults to "MyWpfApp".`),
  framework: z
    .enum(['netcoreapp3.0', 'netcoreapp3.1', 'net5.0', 'net6.0', 'net7.0', 'net8.0', 'net9.0', 'net10.0'])
    .default('net8.0')
    .describe(`Target framework version. Defaults to "net8.0".`),
};

export const searchDocsSchema = {
  query: z
    .string()
    .max(128)
    .optional()
    .describe(`Keyword or phrase to search across documentation titles, tags, control names, and summaries.
      Case-insensitive. Words use OR/ranked matching — topics matching MORE words rank higher, but a topic matching
      only one word can still be returned, so prefer 2-4 distinct/specific words over a full sentence.
      Examples: "restrict floating", "getting started", "column series", "grouping summary".
      Omit entirely (with \`control\` set) to browse ALL topics for a component.`),
  control: z
    .string()
    .max(64)
    .optional()
    .describe(`Optional control name to narrow results, e.g. "XamDockManager", "ContentPane", "XamDataGrid".
      Case-insensitive substring match against the topic's associated control names.
      At least one of \`query\` or \`control\` must be provided.`),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe(`Maximum number of results to return. Defaults to 10, max 50.`),
};

export const getDocSchema = {
  topic: z
    .string()
    .min(1)
    .max(160)
    .describe(`The exact topic slug returned by search_wpf_docs, e.g.
      "xamdockmanager-add-content-to-a-contentpane" or "xamdockmanager-getting-started-with-xamdockmanager".
      Case-insensitive.`),
};

export const listWpfThemesSchema = {
  component: z
    .string()
    .max(64)
    .optional()
    .describe(`Optional component/keyword filter, e.g. "XamDataGrid", "Ribbon", "DataChart", "DockManager".
      Case-insensitive substring match against legacy style folder names AND per-control theme file names
      (both families) — so you can filter by a control folder ("Ribbon") or by a specific file name ("RibbonMetroDark").
      Omit to list every available theme name and legacy style folder with a file count.`),
  theme: z
    .string()
    .max(64)
    .optional()
    .describe(`Optional theme name filter, e.g. "MetroDark", "RoyalDark", "Office2013", "Metro".
      Case-insensitive substring match. Combine with \`component\` to find one exact file.`),
};

export const getWpfThemeResourceSchema = {
  path: z
    .string()
    .min(1)
    .max(200)
    .describe(`The exact resource path returned by list_wpf_themes, e.g.
      "Themes/MetroDark/MetroDark.xamDataChart.xaml" or "DefaultStyles/Ribbon/RibbonMetroDark.xaml".
      Call list_wpf_themes first — never guess this path.`),
};

export const getWpfThemePaletteSchema = {
  theme: z
    .string()
    .max(64)
    .optional()
    .describe(`A newer-family (ThemeManager) theme name, e.g. "MetroDark", "RoyalDark", "RoyalLight",
      "Office2013", "Office2010Blue", "Metro", "IG". Case-insensitive; a substring is accepted.
      Returns that theme's centralized color/brush palette (its \`<Theme>.Theme.Colors.xaml\`) so you can
      re-color the theme by overriding existing keys — NOT create a new theme.
      OMIT this to get the chooser: the list of palette-capable theme names plus how to detect which theme
      the app already uses. Detect the current theme from the workspace FIRST (App.xaml.cs
      \`ThemeManager.ApplicationTheme = new <Name>Theme();\`, an \`Infragistics.WPF.Themes.<Name>.Trial\`
      PackageReference, or a \`Theme="<Name>"\` attribute); if you cannot, ask the user which base theme
      (or dark vs light) they want, then call again with that theme.`),
  filter: z
    .string()
    .max(64)
    .optional()
    .describe(`Optional substring filter matched against the palette group label (e.g. "accent", "error",
      "chart", "base", "gauge"), the resource key (e.g. "Color_024", "Brush01"), the color value
      (e.g. "00AADE", "#FF333333"), or an entry's note.
      Case-insensitive. Omit to return the full palette. Ignored when \`theme\` is omitted.`),
};




export type GetApiReferenceInput = {
  component: string;
  kind: 'all' | 'properties' | 'methods' | 'events';
};

export type SearchApiInput = {
  query: string;
  limit?: number;
};
