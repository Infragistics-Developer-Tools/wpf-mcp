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
  properties: ApiMemberEntry[];
  events:     ApiMemberEntry[];
  methods:    ApiMemberEntry[];
}
