import { z } from 'zod';

export const listComponentsSchema = {
  filter: z
    .string()
    .optional()
    .describe(
      'Optional keyword to filter by component name, description, or NuGet package. ' +
      'Case-insensitive. Examples: "grid", "chart", "dock", "editor". Omit to return all.'
    ),
};

export const getApiReferenceSchema = {
  component: z
    .string()
    .min(1, 'Component name is required.')
    .max(128)
    .describe(
      'Infragistics WPF component name. Case-insensitive. ' +
      'Examples: "XamDataGrid", "XamDockManager", "XamCategoryChart". ' +
      'Call list_wpf_components first if the exact name is unknown.'
    ),
  kind: z
    .enum(['all', 'properties', 'methods', 'events'])
    .default('all')
    .describe(
      'Member category to return. Defaults to "all". ' +
      'Use "properties", "methods", or "events" to reduce response size when you only need one category.'
    ),
};

export const searchApiSchema = {
  query: z
    .string()
    .min(1)
    .max(128)
    .describe(
      'Keyword or phrase to search across type names, summaries, and member names. ' +
      'Case-insensitive. Examples: "filter", "DataSource", "export", "pivot", "series marker".'
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe('Maximum number of results to return. Defaults to 10, max 50.'),
};

export type GetApiReferenceInput = {
  component: string;
  kind: 'all' | 'properties' | 'methods' | 'events';
};

export type SearchApiInput = {
  query: string;
  limit?: number;
};
