# Developer 会员判定修复计划

## 目标

修复 Apple Developer 会员判定：浏览器已经进入会员资格详细信息页、页面出现 Apple Developer Program 计划与续订日期/注册身份等字段时，流程仍输出“未确认”且不保存会员截图。

## 约束

- 浏览器自动化继续只使用 ruyiPage。
- Windows 负责修改、测试、提交和推送；Mac 只做精确提交的只读验证。
- 保留当前工作区已有修改，不使用批量删除、`git reset --hard` 或 `git clean`。
- 会员详情中的原始个人/支付信息不写入日志；只记录脱敏后的布尔证据和字段存在性。

## 执行步骤

1. 检查当前 Developer membership 导航、详情快照、截图和状态上报链路。
2. 对照用户提供的 `report.json`、`flow-audit.jsonl`、`launcher-audit.jsonl` 和截图，确认“已到详情页但 unknown”的根因。
3. 让并行 review 子代理审查静态判定逻辑、测试覆盖和跨 Mac/Node 报告契约。
4. 在 Python ruyiPage 主链路中实现稳健的会员详情证据读取：等待页面稳定，读取计划、续订日期、注册身份等字段，并据此确认 active；详情页/字段缺失时继续 fail-closed。
5. 增加回归测试：中文详情页、英文详情页、仅 URL/标题、字段异步加载、截图前置条件，以及无详情字段时不误判 active。
6. 运行 Python 单测、Node account-browser-flow 测试和项目相关检查。
7. 根据 review 结果进行修改-复审循环；全部 review 通过后再准备 Mac 精确 SHA 验证。

## 验收标准

- 真实页面进入 `#MembershipDetailsCard` 且可读取计划/续订日期/注册身份时，输出 `active`、写入 `developer_membership=已加入`，并在详情内容确认后生成 `03-developer-membership.png`。
- 只有导航链接或 URL 含 membership、没有详情字段时，不确认 active。
- 详情字段存在但页面仍是登录/错误页时，不确认 active。
- audit/report 中只出现脱敏证据，不泄露地址、电话、金额或原始页面文本。

## 验收状态

- 两个只读 review 子代理均已完成修改—复审循环并通过：membership_contract_review=PASS、membership_logic_review=PASS。
- Python 全量：394 tests OK；DeveloperAccountTests：47 tests OK。
- Node test:account-browser-flow, test:flow-audit, py_compile, and git diff --check all passed.
- Windows 已提交并推送会员判定修复；Mac 精确 SHA 验证于 2026-08-01T18:33:06Z 尝试启动，但 macOS 验证主机的 SSH/SCP 连接超时，未产生 Mac 侧验证产物。主机恢复可达后需重试；真实 Apple/2FA 流程仍须使用显式受监督的 Mac 会话。
