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
var log = new ToolLog(args.Contains("--debug"));

var builder = Host.CreateApplicationBuilder(args);
// stdout is the MCP transport — every log line must go to stderr.
builder.Logging.AddConsole(o => o.LogToStandardErrorThreshold = LogLevel.Trace);
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
