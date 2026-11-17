using System.Reflection;
using Infragistics.Wpf.Mcp;
using Infragistics.Wpf.Mcp.Data;
using Infragistics.Wpf.Mcp.Tools;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using ModelContextProtocol.Protocol;

var version = (Assembly.GetExecutingAssembly().GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "0.0.0")
    .Split('+')[0];

var store = new DataStore(Path.Combine(AppContext.BaseDirectory, "data"));
var debug = args.Contains("--debug");
var log = new ToolLog(debug);

// Content root = the tool's own folder, not the MCP client's working directory, so an
// unrelated (or malformed) appsettings.json in the user's workspace is never loaded.
var builder = Host.CreateApplicationBuilder(new HostApplicationBuilderSettings
{
    Args = args,
    ContentRootPath = AppContext.BaseDirectory,
});
// stdout is the MCP transport — every log line must go to stderr.
builder.Logging.AddConsole(o => o.LogToStandardErrorThreshold = LogLevel.Trace);
// MCP clients surface the server's stderr in their logs; the SDK's per-request info lines are
// only worth it when debugging. The "ready" line below is Console.Error, so it always shows.
builder.Logging.SetMinimumLevel(debug ? LogLevel.Information : LogLevel.Warning);
builder.Services.AddSingleton(store);
builder.Services.AddSingleton(log);
builder.Services
    .AddMcpServer(o =>
    {
        o.ServerInfo = new Implementation { Name = "infragistics-wpf", Version = version };
        o.ServerInstructions = ServerInstructions.Text;
    })
    .WithStdioServerTransport()
    .WithTools<ComponentTools>()
    .WithTools<SearchTools>()
    .WithTools<DocsTools>()
    .WithTools<ThemeTools>();

var host = builder.Build();
Console.Error.WriteLine(store.BuildInfo is { } info
    ? $"Infragistics WPF MCP server {version} ready (data: Infragistics {info.InfragisticsVersion}, built {info.BuiltAt[..10]})"
    : $"Infragistics WPF MCP server {version} ready");
await host.RunAsync();
