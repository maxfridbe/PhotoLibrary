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
            Generate("Requests.cs", "wwwsrc/Requests.generated.d.ts");
            Generate("Responses.cs", "wwwsrc/Responses.generated.d.ts");
            Console.WriteLine("TypeScript types generated via Roslyn parser.");
        }

        private static void Generate(string inputFile, string outputFile)
        {
            if (!File.Exists(inputFile)) return;
            string code = File.ReadAllText(inputFile);
            SyntaxTree tree = CSharpSyntaxTree.ParseText(code);
            CompilationUnitSyntax root = tree.GetCompilationUnitRoot();

            var sb = new StringBuilder();
            sb.AppendLine($"// Generated from {inputFile} via Roslyn at {DateTime.Now:O}");
            sb.AppendLine();

            // Handle Records
            foreach (var record in root.DescendantNodes().OfType<RecordDeclarationSyntax>())
            {
                sb.AppendLine($"export interface {record.Identifier.Text} {{");
                if (record.ParameterList != null)
                {
                    foreach (var param in record.ParameterList.Parameters)
                    {
                        string name = param.Identifier.Text;
                        string type = MapType(param.Type?.ToString() ?? "any");
                        sb.AppendLine($"    {name}: {type};");
                    }
                }
                sb.AppendLine("}");
                sb.AppendLine();
            }

            // Handle Classes
            foreach (var @class in root.DescendantNodes().OfType<ClassDeclarationSyntax>())
            {
                // Skip the TypeGen program itself if it's in the same namespace (not the case here but safe)
                if (@class.Identifier.Text == "Program" || @class.Identifier.Text == "WebServer") continue;

                var props = @class.DescendantNodes().OfType<PropertyDeclarationSyntax>()
                    .Where(p => p.Modifiers.Any(m => m.IsKind(SyntaxKind.PublicKeyword)));

                if (props.Any())
                {
                    sb.AppendLine($"export interface {@class.Identifier.Text} {{");
                    foreach (var prop in props)
                    {
                        string name = char.ToLower(prop.Identifier.Text[0]) + prop.Identifier.Text.Substring(1);
                        string type = MapType(prop.Type.ToString());
                        sb.AppendLine($"    {name}: {type};");
                    }
                    sb.AppendLine("}");
                    sb.AppendLine();
                }
            }

            File.WriteAllText(outputFile, sb.ToString());
        }

        private static string MapType(string csType)
        {
            string t = csType.Replace("?", "").Trim();
            bool isArray = t.Contains("[]") || t.StartsWith("IEnumerable") || t.StartsWith("List") || t.StartsWith("ICollection");

            // Extract inner type for generics
            if (t.Contains("<") && t.Contains(">"))
            {
                int start = t.IndexOf("<") + 1;
                int end = t.LastIndexOf(">");
                t = t.Substring(start, end - start);
            }
            else
            {
                t = t.Replace("[]", "");
            }

            string result = "any";
            if (new[] { "string", "DateTime", "Guid" }.Contains(t)) result = "string";
            else if (new[] { "int", "long", "float", "double", "decimal" }.Contains(t)) result = "number";
            else if (t == "bool") result = "boolean";
            else if (t.EndsWith("Response") || t.EndsWith("Request") || t == "MetadataItemResponse" || t == "PhotoResponse") 
                result = t; // Keep custom DTO names
            else result = t;

            return isArray ? result + "[]" : result;
        }
    }
}
