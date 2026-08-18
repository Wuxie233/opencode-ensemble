# OpenCode Ensemble

OpenCode Ensemble coordinates one lead session and multiple teammate sessions around shared work. This glossary fixes the Simplified Chinese language used by the dashboard.

## Language

**项目（Project）**:
共享一个工作目录及其团队集合的工作空间。
_Avoid_: 工程

**团队（Team）**:
由负责人创建、围绕一组共享任务协作的会话集合。
_Avoid_: 小组

**负责人（Lead）**:
创建团队并负责分工、集成、验证和最终交付的主会话。
_Avoid_: 领导、主智能体

**智能体（Agent）**:
团队内承担独立任务的成员会话；实际 Agent 类型（如 `build`、`explore`）保持原名。
_Avoid_: 代理、代理人

**任务（Task）**:
团队共享任务板中可分配、跟踪依赖并标记完成的工作单元。
_Avoid_: 工单

**制品（Artifact）**:
活动团队在 SQLite 控制面内共享的不可变、有界 UTF-8 文本。`contract` 由负责人发布，`task_result` 由当前任务负责人发布；任务只绑定准确的制品 ID 与 SHA-256，不读取隐式最新版。制品不进入 Git 合并，也不是同一系统用户下恶意代码的安全隔离边界。
_Avoid_: 共享工作区、共享源码目录、附件

**接续（Resume）**:
负责人通过 `team_spawn(resume_from)` 创建隔离的新智能体，并把旧智能体会话中最多 32 KiB 的有序上下文仅注入新智能体的首条提示。超限时保留原任务和早期决策，以及最近进展和错误；不会 fork 旧会话，也不会改变旧智能体状态。
_Avoid_: 恢复旧会话、克隆会话
