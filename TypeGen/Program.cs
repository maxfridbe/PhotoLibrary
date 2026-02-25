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
            
            // 1. Build a map of CommLayer methods -> Return Types
            var commLayerMethods = ParseCommLayer("PhotoLibrary.Contracts/ICommunicationLayer.cs");

            if (GenerateTypes("PhotoLibrary.Contracts/Requests.cs", "PhotoLibrary.WFE/wwwsrc/Requests.generated.ts")) mappings.Add(("PhotoLibrary.Contracts/Requests.cs", "PhotoLibrary.WFE/wwwsrc/Requests.generated.ts"));
            if (GenerateTypes("PhotoLibrary.Contracts/Responses.cs", "PhotoLibrary.WFE/wwwsrc/Responses.generated.ts")) mappings.Add(("PhotoLibrary.Contracts/Responses.cs", "PhotoLibrary.WFE/wwwsrc/Responses.generated.ts"));
            if (GenerateTypes("PhotoLibrary.Contracts/Results/Results.cs", "PhotoLibrary.WFE/wwwsrc/Results.generated.ts")) mappings.Add(("PhotoLibrary.Contracts/Results/Results.cs", "PhotoLibrary.WFE/wwwsrc/Results.generated.ts"));
            if (GenerateTypes("PhotoLibrary.Contracts/Models.cs", "PhotoLibrary.WFE/wwwsrc/Models.generated.ts")) mappings.Add(("PhotoLibrary.Contracts/Models.cs", "PhotoLibrary.WFE/wwwsrc/Models.generated.ts"));
            
            if (GenerateFunctions("PhotoLibrary.WFE/WebServer.cs", "PhotoLibrary.WFE/wwwsrc/Functions.generated.ts", commLayerMethods)) mappings.Add(("PhotoLibrary.WFE/WebServer.cs", "PhotoLibrary.WFE/wwwsrc/Functions.generated.ts"));
            
            foreach (var mapping in mappings)
            {
                Console.WriteLine($"Generated: {mapping.From} -> {mapping.To}");
            }
        }

        private static Dictionary<string, string> ParseCommLayer(string file)
        {
            var methods = new Dictionary<string, string>();
            if (!File.Exists(file)) return methods;

            string code = File.ReadAllText(file);
            SyntaxTree tree = CSharpSyntaxTree.ParseText(code);
            var root = tree.GetCompilationUnitRoot();

            foreach (var method in root.DescendantNodes().OfType<MethodDeclarationSyntax>())
            {
                methods[method.Identifier.Text] = method.ReturnType.ToString();
            }

            return methods;
        }

        private static bool GenerateTypes(string inputFile, string outputFile)
        {
            if (!File.Exists(inputFile)) return false;
            string code = File.ReadAllText(inputFile);
            SyntaxTree tree = CSharpSyntaxTree.ParseText(code);
            CompilationUnitSyntax root = tree.GetCompilationUnitRoot();

            var sb = new StringBuilder();
            sb.AppendLine($"// Generated from {inputFile} via Roslyn");
            if (!outputFile.Contains("Requests")) sb.AppendLine("import * as Req from './Requests.generated.js';");
            if (!outputFile.Contains("Responses")) sb.AppendLine("import * as Res from './Responses.generated.js';");
            if (!outputFile.Contains("Results")) sb.AppendLine("import * as Rpc from './Results.generated.js';");
            if (!outputFile.Contains("Models")) sb.AppendLine("import * as Mod from './Models.generated.js';");
            sb.AppendLine();

            foreach (var record in root.DescendantNodes().OfType<RecordDeclarationSyntax>())
            {
                string genericParams = "";
                if (record.TypeParameterList != null)
                {
                    genericParams = "<" + string.Join(", ", record.TypeParameterList.Parameters.Select(p => p.Identifier.Text)) + ">";
                }

                sb.AppendLine($"export interface {record.Identifier.Text}{genericParams} {{");
                if (record.ParameterList != null)
                {
                    foreach (var param in record.ParameterList.Parameters)
                    {
                        string name = char.ToLower(param.Identifier.Text[0]) + param.Identifier.Text.Substring(1);
                        bool isOptional = param.Type?.ToString().Contains("?") ?? false;
                        string type = MapType(param.Type?.ToString() ?? "any");
                        sb.AppendLine($"    {name}{(isOptional ? "?" : "")}: {type}{(isOptional ? " | null" : "")};");
                    }
                }

                // Also scan for properties inside the record body
                var props = record.DescendantNodes().OfType<PropertyDeclarationSyntax>()
                    .Where(p => p.Modifiers.Any(m => m.IsKind(SyntaxKind.PublicKeyword)));

                foreach (var prop in props)
                {
                    string name = char.ToLower(prop.Identifier.Text[0]) + prop.Identifier.Text.Substring(1);
                    bool isOptional = prop.Type.ToString().Contains("?");
                    string type = MapType(prop.Type.ToString());
                    sb.AppendLine($"    {name}{(isOptional ? "?" : "")}: {type}{(isOptional ? " | null" : "")};");
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

        private static bool GenerateFunctions(string inputFile, string outputFile, Dictionary<string, string> commMethods)
        {
            if (!File.Exists(inputFile)) return false;
            string code = File.ReadAllText(inputFile);
            SyntaxTree tree = CSharpSyntaxTree.ParseText(code);
            var root = tree.GetCompilationUnitRoot();

            var sb = new StringBuilder();
            sb.AppendLine($"// Generated from {inputFile} via Roslyn");
            sb.AppendLine("import * as Req from './Requests.generated.js';");
            sb.AppendLine("import * as Res from './Responses.generated.js';");
            sb.AppendLine("import * as Rpc from './Results.generated.js';");
            sb.AppendLine();
            sb.AppendLine("async function post<T>(url: string, data: any = {}): Promise<T> {");
            sb.AppendLine("    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });");
            sb.AppendLine("    if (!res.ok) throw new Error(`API Error: ${res.statusText}`);");
            sb.AppendLine("    const text = await res.text();");
            sb.AppendLine("    return text ? JSON.parse(text) : {} as T;");
            sb.AppendLine("}");
            sb.AppendLine();
            sb.AppendLine("async function postBlob(url: string, data: any = {}): Promise<Blob> {");
            sb.AppendLine("    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });");
            sb.AppendLine("    if (!res.ok) throw new Error(`API Error: ${res.statusText}`);");
            sb.AppendLine("    return await res.blob();");
            sb.AppendLine("}");
            sb.AppendLine();

            var apiCalls = root.DescendantNodes().OfType<InvocationExpressionSyntax>()
                .Where(i => i.Expression.ToString().Contains("MapPost") || i.Expression.ToString().Contains("MapGet"));

            foreach (var inv in apiCalls)
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

                if (parameters != null && parameters.Any())
                {
                    foreach (var param in parameters)
                    {
                        string pt = param.Type?.ToString() ?? "";
                        if (pt.EndsWith("Request")) reqType = "Req." + pt.Replace("?", "");
                        else if (pt.StartsWith("string[]")) reqType = "string[]";
                        else if (pt == "string") reqType = "string";
                    }
                }
                else
                {
                    reqType = "";
                }

                // Resolve Return Type dynamically
                string lambdaBody = lambda.ToString();
                bool isBlob = lambdaBody.Contains("Results.Bytes") || lambdaBody.Contains("Results.File") || lambdaBody.Contains("postBlob") || route.Contains("thumbnail") || route.Contains("download");
                
                if (isBlob)
                {
                    resType = "Blob";
                }
                else
                {
                    // Find all possible method calls to _commLayer in the lambda body
                    var allCalls = lambda.DescendantNodes();
                    foreach (var node in allCalls)
                    {
                        string? methodName = null;
                        if (node is InvocationExpressionSyntax invCall)
                        {
                            string expr = invCall.Expression.ToString();
                            if (expr.Contains("_commLayer?.")) methodName = expr.Split("?.")[1];
                            else if (expr.Contains("_commLayer.")) methodName = expr.Split(".")[1];
                        }
                        else if (node is MemberBindingExpressionSyntax binding)
                        {
                            // This handles the .MethodName part of _commLayer?.MethodName
                            methodName = binding.Name.Identifier.Text;
                        }

                        if (methodName != null && commMethods.TryGetValue(methodName, out var csRetType))
                        {
                            resType = MapType(csRetType);
                            // Ensure contract types are prefixed
                            var knownContractTypes = new[] { 
                                "Response", "StatsResponse", "ScanFileResult", "DirectoryResponse", "CollectionCreatedResponse" 
                            };
                            
                            if (!resType.StartsWith("Res.") && !resType.StartsWith("Rpc.") && !resType.Contains("[]") && !resType.Contains("<"))
                            {
                                if (knownContractTypes.Any(kt => resType.EndsWith(kt))) resType = "Res." + resType;
                            }
                            else if (resType.Contains("[]"))
                            {
                                string baseType = resType.Replace("[]", "");
                                if (knownContractTypes.Any(kt => baseType.EndsWith(kt)) && !baseType.StartsWith("Res."))
                                    resType = "Res." + baseType + "[]";
                            }

                            if (resType.StartsWith("RpcResult")) resType = "Rpc." + resType;
                            break;
                        }
                    }

                    // Special case: Results.Json(new { ... })
                    if (resType == "any" && lambdaBody.Contains("Results.Json(new {"))
                    {
                        // Try to extract keys
                        var anon = lambda.DescendantNodes().OfType<AnonymousObjectCreationExpressionSyntax>().FirstOrDefault();
                        if (anon != null)
                        {
                            resType = "{ " + string.Join(", ", anon.Initializers.Select(i => {
                                string name = i.NameEquals?.Name.Identifier.Text ?? "unknown";
                                return $"{name}: any";
                            })) + " }";
                        }
                    }
                }

                string postFunc = isBlob ? "postBlob" : "post";
                if (resType == "Task") resType = "void"; // Map naked Task to void

                if (string.IsNullOrEmpty(reqType))
                {
                    sb.AppendLine($"export async function api_{funcName}(): Promise<{resType}> {{");
                    sb.AppendLine($"    return await {postFunc}('{route}');");
                }
                else
                {
                    sb.AppendLine($"export async function api_{funcName}(data: {reqType}): Promise<{resType}> {{");
                    sb.AppendLine($"    return await {postFunc}('{route}', data);");
                }
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

            string wrapper = null;
            if (t.Contains("<") && t.Contains(">"))
            {
                int start = t.IndexOf("<");
                wrapper = t.Substring(0, start);
                int end = t.LastIndexOf(">");
                t = t.Substring(start + 1, end - start - 1);
                
                // Special case for nested generics like Task<List<string>>
                if (t.Contains("<"))
                {
                    string innerMapped = MapType(t);
                    if (wrapper == "Task") return innerMapped;
                    return $"{wrapper}<{innerMapped}>";
                }
            }
            else t = t.Replace("[]", "");

            string result = "any";
            if (new[] { "string", "DateTime", "Guid" }.Contains(t)) result = "string";
            else if (new[] { "int", "long", "float", "double", "decimal", "byte" }.Contains(t)) result = "number";
            else if (t == "bool") result = "boolean";
            else if (t == "void" || t == "Task") result = "void";
            else result = t;

            if (isArray) result += "[]";
            
            if (wrapper != null)
            {
                if (wrapper == "RpcResult") return $"Rpc.RpcResult<{result}>";
                if (wrapper == "Task") return result; // Unwrap Task<T>
                // List<T> or IEnumerable<T> already handled by isArray if they were identified as such
                if (isArray && (wrapper == "List" || wrapper == "IEnumerable" || wrapper == "ICollection")) return result;
                
                return $"{wrapper}<{result}>";
            }

            return result;
        }
    }
}
