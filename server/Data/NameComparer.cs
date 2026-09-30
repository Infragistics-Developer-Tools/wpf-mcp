namespace Infragistics.Wpf.Mcp.Data;

/// Deterministic stand-in for JS `localeCompare` on ASCII identifiers (the only input the
/// data contains): punctuation/symbols sort before digits before letters, letters compare
/// case-insensitively with lowercase first on a tie — so "Xam`1" < "XamBase" and
/// "XamGridFilteringX" < "XamGridFilterMenu", matching the npm server's ordering on any OS.
public sealed class NameComparer : IComparer<string>
{
    public static readonly NameComparer Instance = new();

    public int Compare(string? x, string? y)
    {
        if (ReferenceEquals(x, y)) return 0;
        if (x is null) return -1;
        if (y is null) return 1;

        var n = Math.Min(x.Length, y.Length);
        var caseTie = 0;
        for (var i = 0; i < n; i++)
        {
            var a = x[i];
            var b = y[i];
            if (a == b) continue;

            var ra = Rank(a);
            var rb = Rank(b);
            if (ra != rb) return ra - rb;

            var la = char.ToLowerInvariant(a);
            var lb = char.ToLowerInvariant(b);
            if (la != lb) return la - lb;

            if (caseTie == 0) caseTie = char.IsLower(a) ? -1 : 1;
        }
        return x.Length != y.Length ? x.Length - y.Length : caseTie;
    }

    private static int Rank(char c) => char.IsLetter(c) ? 2 : char.IsDigit(c) ? 1 : 0;
}
