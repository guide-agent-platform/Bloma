---
type: web_fullstack
level: standard
version: 1
name: Web 全栈
---
# 模板：Web 全栈（PRD 12.3 标准级）

适用：博客、商城、管理后台、官网、论坛等多页面 Web 项目。

## 硬约束等级：标准（PRD 12.4 标准列）

- PRD 必须包含：项目名称、核心功能、目标用户、验收标准
- API Spec：每个端点完整定义（沙箱静态应用阶段可空数组，接口清单进背板 interface_spec）
- 安全扫描：OWASP Top 10（XSS 注入 / 敏感数据暴露必测）
- 测试覆盖率：全部功能 + 边界

## PRD 章节必填子集

- quick：产品定位 / 功能清单 / 页面清单(≤3) / 行为断言(EARS) / GWT 场景 / 范围外
- longterm：+ 目标用户 / 术语表 / API Spec

## 依赖白名单（loop 引白名单外包 → 工具层拦截）

- 允许：原生 HTML / CSS / JavaScript（ES2022），无构建链静态产物
- 允许：localStorage / fetch（同源）
- 禁止：外部 CDN / npm 包 / 后端框架 / 数据库（沙箱阶段）
- 禁止：内联第三方统计/广告脚本

## tech_skeleton（目录约定 / 构建配置 / 入口约定）

- index.html 为唯一入口（<style> 内联或 link 引 src/style.css，</html> 收尾——isHtmlDocument 判据）
- src/app.js 为逻辑入口（含全部交互逻辑；hasInteractiveEntry 判据：addEventListener/onclick 家族）
- src/style.css 可选拆分
- 多页面约定：单 index.html 内分区实现（沙箱 static-server 单入口约束）

## 测试策略

- 安全扫描等级 = OWASP Top 10（XSS：<script>alert(1)</script> 注入用例必测；敏感数据不暴露）
- 测试覆盖率 = 全部功能 + 边界（每功能项：正常路径 + 空输入/非法值边界各≥1）
- GWT 必测类别：happy path / 边界（空输入、超长输入）/ 异常（非法值、网络失败态）

## 同类型脱敏样例（few-shot，≤500 token，注入 PRD 生成）

需求：帮我做一个家庭记账本，记每天花销，月底看汇总。
定位：面向个人与家庭的记账工具，日常收支快速记录，月底直观看到结余。
功能与断言（EARS 形态）：
- F-001 记录收支：WHEN 点击保存按钮 → 列表新增一条记录；IF 金额为空或非数字 → 提示错误且不保存
- F-002 月度汇总：WHEN 新增一笔支出 → 本月结余数值更新；WHILE 本月无任何记录 → 结余显示 0
范围外：多用户协作、银行账户自动对接。
