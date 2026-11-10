# Domain Docs

This repo has one domain context: root `GLOSSARY.md` and `docs/adr/`.

## Before exploring

1. Start at [current documentation](../README.md) and select the topic relevant to the task.
2. Read the relevant terms in root [GLOSSARY](../../GLOSSARY.md).
3. Read applicable ADRs from the current index, including their implementation status. Preserve confirmed pending designs as designs; they do not prove a runtime feature exists.

Apply the documentation rules in root [AGENTS](../../AGENTS.md#新功能设计的文档依据): routine file discovery, searches and reading exclude `docs/archive/**`; historical links do not trigger a lookup. Read historical material only when the user explicitly asks for it.

## Use the glossary's vocabulary

Use the defined domain terms in designs, issue titles and code. When a needed term is missing, distinguish a real domain gap from a new synonym; update the glossary only when its meaning is resolved. Keep implementation steps in topic docs.

## Flag conflicts

If a proposal contradicts a still-effective decision, identify that ADR and the proposed change explicitly. When documentation and code differ, state whether the text is a confirmed pending design or a stale description; do not silently treat either as an implemented feature.
