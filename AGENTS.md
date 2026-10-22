# Git 提交规范

- 每次提交并推送项目代码时，提交说明都使用“英文类型前缀 + 中文说明”的格式。
- 格式：`<英文前缀>: <中文说明>`。
- 英文前缀使用简短、常见的 Conventional Commits 类型，例如 `feat`、`fix`、`docs`、`refactor`、`test`、`chore`。
- 示例：`feat: 增加客户线索筛选`、`fix: 修复飞书分页读取`。
- 冒号后的说明使用中文，清楚概括本次变更。

## Agent skills

### Issue tracker

Issues and specs live in this repo's GitHub Issues; use the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

Use the single-context layout: root `GLOSSARY.md` and `docs/adr/`. See `docs/agents/domain.md`.
