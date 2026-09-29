#!/usr/bin/env python3
"""Prepara o harness de verificação do patch de conformidade do MCP do Autopsy.

Por que existe: o PR toca `Core/src/org/sleuthkit/autopsy/mcp/`, cujo `TskQueryService`
depende da árvore inteira do Autopsy (TSK, NetBeans) e não compila fora do build deles.
Para ainda assim **executar** o teste JUnit do patch, este script monta um `TskQueryService`
stub cujas definições de tool (`listTools()` + helpers) são copiadas **verbatim** do upstream —
então o teste exercita os schemas reais contra o `McpProtocolHandler` real.

Uso:
    python3 prepare.py <TskQueryService.java do upstream> <patch> <saida do stub> <saida do teste>
"""

import re
import sys


def extrair(src: str, assinatura: str) -> str:
    """Devolve o método (assinatura + corpo) a partir da assinatura dada."""
    i = src.index(assinatura)
    j = src.index("{", i)
    depth = 0
    for k in range(j, len(src)):
        if src[k] == "{":
            depth += 1
        elif src[k] == "}":
            depth -= 1
            if depth == 0:
                return src[i : k + 1]
    raise SystemExit(f"não fechei o método: {assinatura}")


def gerar_stub(upstream: str) -> str:
    sigs = [
        ("listTools", 0, "List<Map<String, Object>> listTools()"),
        (
            "toolWithNote",
            2,
            "private Map<String, Object> toolWithNote(String name, String description, "
            "Map<String, Object> properties)",
        ),
        (
            "toolWithNote",
            3,
            "private Map<String, Object> toolWithNote(String name, String description, "
            "Map<String, Object> properties, List<String> required)",
        ),
        (
            "tool",
            2,
            "private Map<String, Object> tool(String name, String description, "
            "Map<String, Object> properties)",
        ),
        (
            "tool",
            3,
            "private Map<String, Object> tool(String name, String description, "
            "Map<String, Object> properties, List<String> required)",
        ),
        (
            "param",
            1,
            "private Map<String, Object> param(String type, String description)",
        ),
    ]
    corpos = {(nome, n): extrair(upstream, sig) for nome, n, sig in sigs}

    listtools = corpos[("listTools", 0)]
    helpers = (
        "\n\n".join("    " + corpos[("toolWithNote", n)].strip() for n in (2, 3))
        + "\n\n"
    )
    helpers += (
        "\n\n".join("    " + corpos[("tool", n)].strip() for n in (2, 3)) + "\n\n"
    )
    helpers += "    " + corpos[("param", 1)].strip() + "\n"

    m = re.search(r"private static final String CASE_ID_NOTE\s*=[^;]+;", upstream)
    case_id = m.group(0) if m else ""

    chamados = [
        "queryFiles",
        "queryDataArtifacts",
        "queryAnalysisResults",
        "getHosts",
        "queryDataSources",
        "getDataSourceTree",
        "getCaseSummary",
        "getFileContent",
        "queryTags",
        "queryTimeline",
        "summarizeTimeline",
        "getOsAccounts",
        "getCommunicationsAccounts",
        "getAccountRelationships",
        "getObjectChildren",
        "listReports",
        "getReportContent",
        "getCaseName",
    ]
    stubs = []
    for nome in chamados:
        mm = re.search(
            r"^\s{4}([\w<>, \[\]]+?) " + nome + r"\(([^)]*)\)[^{;]*\{", upstream, re.M
        )
        if not mm:
            raise SystemExit(f"não achei a declaração de {nome} no upstream")
        ret, params = mm.group(1).strip(), mm.group(2).strip()
        corpo = (
            "return null;"
            if nome == "getCaseName"
            else 'throw new UnsupportedOperationException("stub de verificação");'
        )
        stubs.append(f"    {ret} {nome}({params}) {{ {corpo} }}")

    return (
        "package org.sleuthkit.autopsy.mcp;\n\n"
        "import com.fasterxml.jackson.databind.JsonNode;\n"
        "import java.util.List;\n"
        "import java.util.Map;\n\n"
        "/*\n"
        " * STUB DE VERIFICAÇÃO — listTools() e os helpers abaixo são copiados VERBATIM de\n"
        " * TskQueryService.java do upstream, para que o teste exercite os schemas reais.\n"
        " * Os demais métodos não são usados por tools/list e apenas satisfazem a compilação.\n"
        " */\n"
        "class TskQueryService {\n\n"
        f"    {case_id}\n\n"
        "    TskQueryService(Object a, Object b) { }\n\n"
        f"    {listtools.strip()}\n\n{helpers}\n" + "\n".join(stubs) + "\n}\n"
    )


def extrair_teste(patch: str) -> str:
    """Extrai o arquivo de teste novo de dentro do patch (linhas iniciadas por '+')."""
    marcador = "McpProtocolHandlerTest.java"
    i = patch.index(marcador)
    linhas = []
    for linha in patch[i:].split("\n")[1:]:
        if linha.startswith("+"):
            linhas.append(linha[1:])
        elif linha.startswith("@@") or linha.startswith("---") or linha.strip() == "":
            continue
        else:
            break
    if not linhas:
        raise SystemExit("não consegui extrair o teste de dentro do patch")
    return "\n".join(linhas) + "\n"


def main() -> None:
    upstream_path, patch_path, stub_out, test_out = sys.argv[1:5]
    upstream = open(upstream_path, encoding="utf-8").read()
    patch = open(patch_path, encoding="utf-8").read()
    open(stub_out, "w", encoding="utf-8").write(gerar_stub(upstream))
    open(test_out, "w", encoding="utf-8").write(extrair_teste(patch))
    print(f"stub: {stub_out}")
    print(f"teste: {test_out}")


if __name__ == "__main__":
    main()
