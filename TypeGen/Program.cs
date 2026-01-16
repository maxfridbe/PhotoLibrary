using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Collections.Generic;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace TypeGen
{
    public class Program
    {
        public static void Main(string[] args)
        {
            var mappings = new List<(string From, string To)>();
            
            if (GenerateTypes("PhotoLibrary/Requests.cs", "PhotoLibrary/wwwsrc/Requests.generated.ts")) mappings.Add(("PhotoLibrary/Requests.cs", "PhotoLibrary/wwwsrc/Requests.generated.ts"));
            if (GenerateTypes("PhotoLibrary/Responses.cs", "PhotoLibrary/wwwsrc/Responses.generated.ts")) mappings.Add(("PhotoLibrary/Responses.cs", "PhotoLibrary/wwwsrc/Responses.generated.ts"));
            if (GenerateFunctions("PhotoLibrary/WebServer.cs", "PhotoLibrary/wwwsrc/Functions.generated.ts")) mappings.Add(("PhotoLibrary/WebServer.cs", "PhotoLibrary/wwwsrc/Functions.generated.ts"));
            
            foreach (var mapping in mappings)
            {
                Console.WriteLine($"Generated: {mapping.From} -> {mapping.To}");
            }
        }

        private static bool GenerateTypes(string inputFile, string outputFile)
        {
            if (!File.Exists(inputFile)) return false;
            string code = File.ReadAllText(inputFile);
            SyntaxTree tree = CSharpSyntaxTree.ParseText(code);
            CompilationUnitSyntax root = tree.GetCompilationUnitRoot();

            var sb = new StringBuilder();
            sb.AppendLine($"// Generated from {inputFile} via Roslyn at {DateTime.Now:O}");
            sb.AppendLine("import * as Req from './Requests.generated.js';");
            sb.AppendLine("import * as Res from './Responses.generated.js';");
            sb.AppendLine();

            foreach (var record in root.DescendantNodes().OfType<RecordDeclarationSyntax>())
            {
                sb.AppendLine($"export interface {record.Identifier.Text} {{");
                if (record.ParameterList != null)
                {
                    foreach (var param in record.ParameterList.Parameters)
                    {
                        string name = param.Identifier.Text;
                        bool isOptional = param.Type?.ToString().Contains("?") ?? false;
                        string type = MapType(param.Type?.ToString() ?? "any");
                        sb.AppendLine($"    {name}{(isOptional ? "?" : "")}: {type};");
                    }
                }
                sb.AppendLine("}");
                sb.AppendLine();
            }

            foreach (var cls in root.DescendantNodes().OfType<ClassDeclarationSyntax>())
            {
                if (cls.Identifier.Text == "Program" || cls.Identifier.Text == "WebServer") continue;
                var props = cls.DescendantNodes().OfType<PropertyDeclarationSyntax>()
                    .Where(p => p.Modifiers.Any(m => m.IsKind(SyntaxKind.PublicKeyword)));

                if (props.Any())
                {
                    sb.AppendLine($"export interface {cls.Identifier.Text} {{");
                    foreach (var prop in props)
                    {
                        string name = char.ToLower(prop.Identifier.Text[0]) + prop.Identifier.Text.Substring(1);
                        bool isOptional = prop.Type.ToString().Contains("?");
                        string type = MapType(prop.Type.ToString());
                        sb.AppendLine($"    {name}{(isOptional ? "?" : "")}: {type};");
                    }
                    sb.AppendLine("}");
                    sb.AppendLine();
                }
            }

            File.WriteAllText(outputFile, sb.ToString());
            return true;
        }

        private static bool GenerateFunctions(string inputFile, string outputFile)
        {
            if (!File.Exists(inputFile)) return false;
            string code = File.ReadAllText(inputFile);
            SyntaxTree tree = CSharpSyntaxTree.ParseText(code);
            var root = tree.GetCompilationUnitRoot();

            var sb = new StringBuilder();
            sb.AppendLine($"// Generated from {inputFile} via Roslyn at {DateTime.Now:O}");
            sb.AppendLine("import * as Req from './Requests.generated.js';");
            sb.AppendLine("import * as Res from './Responses.generated.js';");
            sb.AppendLine();
            sb.AppendLine("async function post<T>(url: string, data: any = {}): Promise<T> {");
            sb.AppendLine("    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });");
            sb.AppendLine("    if (!res.ok) throw new Error(`API Error: ${res.statusText}`);");
            sb.AppendLine("    const text = await res.text();");
            sb.AppendLine("    return text ? JSON.parse(text) : {} as T;");
            sb.AppendLine("}");
            sb.AppendLine();

            var mapPosts = root.DescendantNodes().OfType<InvocationExpressionSyntax>()
                .Where(i => i.Expression.ToString().Contains("MapPost"));

            foreach (var inv in mapPosts)
            {
                var args = inv.ArgumentList.Arguments;
                if (args.Count < 2) continue;

                string route = args[0].ToString().Replace("\"", "");
                string funcName = route.Replace("/api/", "").Replace("/", "_").Replace("-", "_");
                if (funcName.Contains("{")) funcName = funcName.Split('{')[0].TrimEnd('_');

                string reqType = "any";
                string resType = "any";

                var lambda = args[1].Expression;
                IEnumerable<ParameterSyntax>? parameters = null;

                if (lambda is ParenthesizedLambdaExpressionSyntax pLambda)
                    parameters = pLambda.ParameterList.Parameters;
                else if (lambda is SimpleLambdaExpressionSyntax sLambda)
                    parameters = new[] { sLambda.Parameter };

                if (parameters != null)
                {
                    foreach (var param in parameters)
                    {
                        string pt = param.Type?.ToString() ?? "";
                        if (pt.EndsWith("Request")) reqType = "Req." + pt.Replace("?", "");
                        else if (pt.StartsWith("string[]")) reqType = "string[]";
                    }
                }

                if (route.Contains("photos")) resType = "Res.PagedPhotosResponse";
                else if (route.Contains("metadata")) resType = "Res.MetadataGroupResponse[]";
                else if (route.Contains("directories")) resType = "Res.DirectoryNodeResponse[]";
                else if (route.Contains("collections/list")) resType = "Res.CollectionResponse[]";
                else if (route.Contains("stats")) resType = "Res.StatsResponse";
                else if (route.Contains("picked/ids") || route.Contains("get-files") || route.Contains("search")) resType = "string[]";

                sb.AppendLine($"export async function api_{funcName}(data: {reqType}): Promise<{resType}> {{");
                sb.AppendLine($"    return await post<{resType}>('{route}', data);");
                sb.AppendLine("}");
                sb.AppendLine();
            }

            File.WriteAllText(outputFile, sb.ToString());
            return true;
        }

        private static string MapType(string csType)
        {
            string t = csType.Replace("?", "").Trim();

            if (t.StartsWith("Dictionary<") || t.StartsWith("IDictionary<"))
            {
                int start = t.IndexOf("<") + 1;
                int end = t.LastIndexOf(">");
                var inner = t.Substring(start, end - start);
                var comma = inner.IndexOf(",");
                var keyType = MapType(inner.Substring(0, comma));
                var valueType = MapType(inner.Substring(comma + 1));
                return $"{{ [key: {keyType}]: {valueType} }}";
            }

            bool isArray = t.Contains("[]") || t.StartsWith("IEnumerable") || t.StartsWith("List") || t.StartsWith("ICollection");

            if (t.Contains("<") && t.Contains(">"))
            {
                int start = t.IndexOf("<") + 1;
                int end = t.LastIndexOf(">");
                t = t.Substring(start, end - start);
            }
            else t = t.Replace("[]", "");

            string result = "any";
            if (new[] { "string", "DateTime", "Guid" }.Contains(t)) result = "string";
            else if (new[] { "int", "long", "float", "double", "decimal" }.Contains(t)) result = "number";
            else if (t == "bool") result = "boolean";
            else result = t;

            return isArray ? result + "[]" : result;
        }
    }
}
