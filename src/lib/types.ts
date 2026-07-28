export interface ComponentEntry {
  component: string;
  xamlNamespace: string;
  defaultPrefix: string;
  dotnetNamespace: string;
  nugetPackage: string;
  assembly: string;
  description: string;
}

export interface ApiMemberEntry {
  name: string;
  summary: string;
  typeName?: string;
  isNullable?: boolean;
  isEnum?: boolean;
  enumValues?: string[];
  declaredOn?: string;
}

export interface ApiEntry {
  component: string;
  assembly: string;
  nugetPackage: string;
  xamlNamespace: string;
  defaultPrefix: string;
  dotnetNamespace: string;
  summary: string;
  remarks: string;
  /** Immediate base type name, if it is also an indexed Infragistics type. Drives generic "check the base class" guidance. */
  baseType?: string;
  properties: ApiMemberEntry[];
  events:     ApiMemberEntry[];
  methods:    ApiMemberEntry[];
}

/** Compact entry in search-index.json — loaded once at startup */
export interface SearchIndexEntry {
  n: string;   // typeName
  s: string;   // summary
  a: string;   // assembly
  p: string;   // nugetPackage
  m: string[]; // member names (props + events + methods)
}

// ── Docs types ────────────────────────────────────────────────────────────────

/** Lightweight entry in docs-index.json — loaded once at startup */
export interface DocIndexEntry {
  slug:         string;    // e.g. "xamdockmanager-add-content-to-a-contentpane"
  title:        string;    // e.g. "Add Content to a ContentPane"
  controlNames: string[];  // e.g. ["xamDockManager"]
  tags:         string[];  // e.g. ["How Do I", "Getting Started"]
  source:       'wpf' | 'common';
  summary:      string;    // first ~220 chars of plain body text
}

/** Full topic — loaded on demand from docs/{slug}.json */
export interface DocEntry extends DocIndexEntry {
  body:         string;    // full stripped text (code block content as plain text)
  xamlSnippets: string[];  // extracted XAML-only code blocks in document order
}
