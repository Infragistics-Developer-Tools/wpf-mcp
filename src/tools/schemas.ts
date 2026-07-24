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

export type GetApiReferenceInput = {
  component: string;
  kind: 'all' | 'properties' | 'methods' | 'events';
};

export type SearchApiInput = {
  query: string;
  limit?: number;
};
