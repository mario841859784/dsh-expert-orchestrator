# 专家库清单与来源声明（EXPERTS.md）

本插件的专家提示词按 `来源` frontmatter 字段标注出处；所有上游项目均为 MIT 许可证，
本仓库的分发遵循 MIT 并在此声明致谢。专家正文版权归各自上游作者所有。

| 来源 | 数量 | 说明 |
|---|---|---|
| 本项目自建 | 11 | — |
| [VoltAgent/awesome-claude-code-subagents](https://github.com/VoltAgent/awesome-claude-code-subagents) (MIT) | 62 | 技术栈专项：语言/框架、基础设施、数据与 AI、质量调试、开发者体验、垂直栈、架构模式 |
| [wshobson/agents](https://github.com/wshobson/agents) (MIT) | 4 | 独有技术栈：Julia、ARM Cortex、NVIDIA DGX 运维、LLM 微调 |
| [jnMetaCode/agency-agents-zh](https://github.com/jnMetaCode/agency-agents-zh) (MIT) | 1 | 中文生态增量：搜索增长编排器 |

## 来源：本项目自建

| 分区 | 专家 | 适用任务 |
|---|---|---|
|  | **后端工程师** (`backend-engineer`) | 服务端接口与业务逻辑、数据库设计与查询、性能与并发问题、API 契约 |
|  | **代码审查专家** (`code-reviewer`) | 代码评审、缺陷与风险识别、重构建议、提交前质量把关 |
|  | **数据分析专家** (`data-analyst`) | 数据清洗与统计、日志与指标分析、SQL 查询、趋势与异常解读 |
|  | **运维工程师** (`devops-engineer`) | 部署与发布、构建/CI 配置、环境与依赖排查、服务监控与故障恢复 |
|  | **前端工程师** (`frontend-engineer`) | 页面/组件实现、样式与交互、前端性能与浏览器兼容、React/Vue 等框架问题排查 |
|  | **通用执行专家** (`generalist`) | 没有明确领域匹配时的兜底执行者；跨领域小任务、调研、脚本编写、环境排查 |
|  | **产品与交互设计专家** (`product-designer`) | 需求梳理与拆解、交互方案与信息架构、原型说明、体验问题诊断 |
|  | **项目经理（规划）** (`project-manager`) | Agency 花名册不可用时的 PM 兜底；需求拆解、任务分解、排期与验收标准制定、范围与风险控制 |
|  | **测试工程师** (`qa-test-engineer`) | 测试用例设计与编写、回归验证、缺陷复现与定位、验收测试 |
|  | **安全审计专家** (`security-auditor`) | 安全漏洞排查、依赖与配置审计、注入/越权/敏感信息泄露检查、加固建议 |
|  | **技术文档工程师** (`tech-writer`) | README/API 文档/使用指南撰写与更新、变更说明、注释与示例 |

## 来源：[VoltAgent/awesome-claude-code-subagents](https://github.com/VoltAgent/awesome-claude-code-subagents) (MIT)

| 分区 | 专家 | 适用任务 |
|---|---|---|
| 01-core-development | **Electron Pro** (`electron-pro`) | Use this agent when building Electron desktop applications that require native OS integration, cross-platform … |
| 01-core-development | **Graphql Architect** (`graphql-architect`) | Use this agent when designing or evolving GraphQL schemas across microservices, implementing federation archit… |
| 01-core-development | **Microservices Architect** (`microservices-architect`) | Use when designing distributed system architecture, decomposing monolithic applications into independent micro… |
| 01-core-development | **Websocket Engineer** (`websocket-engineer`) | Use this agent when implementing real-time bidirectional communication features using WebSockets, Socket.IO, o… |
| 02-language-specialists | **Angular Architect** (`angular-architect`) | Use when architecting enterprise Angular 15+ applications with complex state management, optimizing RxJS patte… |
| 02-language-specialists | **Cpp Pro** (`cpp-pro`) | Use this agent when building high-performance C++ systems requiring modern C++20/23 features, template metapro… |
| 02-language-specialists | **Csharp Developer** (`csharp-developer`) | Use this agent when building ASP.NET Core web APIs, cloud-native .NET solutions, or modern C# applications req… |
| 02-language-specialists | **Django Developer** (`django-developer`) | Use when building Django 4+ web applications, REST APIs, or modernizing existing Django projects with async vi… |
| 02-language-specialists | **Dotnet Core Expert** (`dotnet-core-expert`) | Use when building .NET Core applications requiring cloud-native architecture, high-performance microservices, … |
| 02-language-specialists | **Elixir Expert** (`elixir-expert`) | Use this agent when you need to build fault-tolerant, concurrent systems leveraging OTP patterns, GenServer ar… |
| 02-language-specialists | **Expo React Native Expert** (`expo-react-native-expert`) | Use when building mobile applications with Expo and React Native that require native module integration, navig… |
| 02-language-specialists | **Fastapi Developer** (`fastapi-developer`) | Use when building modern async Python APIs with FastAPI, implementing Pydantic v2 validation, dependency injec… |
| 02-language-specialists | **Flutter Expert** (`flutter-expert`) | Use when building cross-platform mobile applications with Flutter 3+ that require custom UI implementation, co… |
| 02-language-specialists | **Golang Pro** (`golang-pro`) | Use when building Go applications requiring concurrent programming, high-performance systems, microservices, o… |
| 02-language-specialists | **Java Architect** (`java-architect`) | Use this agent when designing enterprise Java architectures, migrating Spring Boot applications, or establishi… |
| 02-language-specialists | **Javascript Pro** (`javascript-pro`) | Use this agent when you need to build, optimize, or refactor modern JavaScript code for browser, Node.js, or f… |
| 02-language-specialists | **Kotlin Specialist** (`kotlin-specialist`) | Use when building Kotlin applications requiring advanced coroutine patterns, multiplatform code sharing, or An… |
| 02-language-specialists | **Laravel Specialist** (`laravel-specialist`) | Use when building Laravel 10+ applications, architecting Eloquent models with complex relationships, implement… |
| 02-language-specialists | **Nextjs Developer** (`nextjs-developer`) | Use this agent when building production Next.js 14+ applications that require full-stack development with App … |
| 02-language-specialists | **Node Specialist** (`node-specialist`) | Use this agent when you need to build, optimize, or debug Node.js backend applications, APIs, CLIs, or microse… |
| 02-language-specialists | **Php Pro** (`php-pro`) | Use this agent when working with PHP 8.3+ projects that require strict typing, modern language features, and e… |
| 02-language-specialists | **Powershell 7 Expert** (`powershell-7-expert`) | Use when building cross-platform cloud automation scripts, Azure infrastructure orchestration, or CI/CD pipeli… |
| 02-language-specialists | **Python Pro** (`python-pro`) | Use this agent when you need to build type-safe, production-ready Python code for web APIs, system utilities, … |
| 02-language-specialists | **Rails Expert** (`rails-expert`) | Use when building or modernizing Rails applications requiring API development, Hotwire reactivity, real-time f… |
| 02-language-specialists | **React Specialist** (`react-specialist`) | Use when optimizing existing React applications for performance, implementing advanced React 18+ features, or … |
| 02-language-specialists | **Rust Engineer** (`rust-engineer`) | Use when building Rust systems where memory safety, ownership patterns, zero-cost abstractions, and performanc… |
| 02-language-specialists | **Spring Boot Engineer** (`spring-boot-engineer`) | Use this agent when building enterprise Spring Boot 3+ applications requiring microservices architecture, clou… |
| 02-language-specialists | **Sql Pro** (`sql-pro`) | Use this agent when you need to optimize complex SQL queries, design efficient database schemas, or solve perf… |
| 02-language-specialists | **Swift Expert** (`swift-expert`) | Use this agent when building native iOS, macOS, or server-side Swift applications requiring advanced concurren… |
| 02-language-specialists | **Symfony Specialist** (`symfony-specialist`) | Use when building Symfony 6+/7+/8+ applications, architecting Doctrine ORM entities with complex relationships… |
| 02-language-specialists | **Typescript Pro** (`typescript-pro`) | Use when implementing TypeScript code requiring advanced type system patterns, complex generics, type-level pr… |
| 02-language-specialists | **Vue Expert** (`vue-expert`) | Use this agent when building Vue 3 applications that require Composition API mastery, reactivity optimization,… |
| 03-infrastructure | **Azure Infra Engineer** (`azure-infra-engineer`) | Use when designing, deploying, or managing Azure infrastructure with focus on network architecture, Entra ID i… |
| 03-infrastructure | **Database Administrator** (`database-administrator`) | Use this agent when optimizing database performance, implementing high-availability architectures, setting up … |
| 03-infrastructure | **Docker Expert** (`docker-expert`) | Use this agent when you need to build, optimize, or secure Docker container images and orchestration for produ… |
| 03-infrastructure | **Kubernetes Specialist** (`kubernetes-specialist`) | Use this agent when you need to design, deploy, configure, or troubleshoot Kubernetes clusters and workloads i… |
| 03-infrastructure | **Terraform Engineer** (`terraform-engineer`) | Use when building, refactoring, or scaling infrastructure as code using Terraform with focus on multi-cloud de… |
| 03-infrastructure | **Terragrunt Expert** (`terragrunt-expert`) | Expert Terragrunt specialist mastering infrastructure orchestration, DRY configurations, and multi-environment… |
| 03-infrastructure | **Windows Infra Admin** (`windows-infra-admin`) | Use when managing Windows Server infrastructure, Active Directory, DNS, DHCP, and Group Policy configurations,… |
| 04-quality-security | **Ad Security Reviewer** (`ad-security-reviewer`) | Use this agent when you need to audit Active Directory security posture, evaluate privilege escalation risks, … |
| 04-quality-security | **Chaos Engineer** (`chaos-engineer`) | Use this agent when you need to design and execute controlled failure experiments, validate system resilience … |
| 04-quality-security | **Debugger** (`debugger`) | Use this agent when you need to diagnose and fix bugs, identify root causes of failures, or analyze error logs… |
| 04-quality-security | **Error Detective** (`error-detective`) | Use this agent when you need to diagnose why errors are occurring in your system, correlate errors across serv… |
| 04-quality-security | **Performance Engineer** (`performance-engineer`) | Use this agent when you need to identify and eliminate performance bottlenecks in applications, databases, or … |
| 05-data-ai | **Llm Architect** (`llm-architect`) | Use when designing LLM systems for production, implementing fine-tuning or RAG architectures, optimizing infer… |
| 05-data-ai | **Machine Learning Engineer** (`machine-learning-engineer`) | Use this agent when you need to deploy, optimize, or serve machine learning models at scale in production envi… |
| 05-data-ai | **Mlops Engineer** (`mlops-engineer`) | Use this agent when you need to design and implement ML infrastructure, set up CI/CD for machine learning mode… |
| 05-data-ai | **Nlp Engineer** (`nlp-engineer`) | Use when building production NLP systems, implementing text processing pipelines, developing language models, … |
| 05-data-ai | **Postgres Pro** (`postgres-pro`) | Use when you need to optimize PostgreSQL performance, design high-availability replication, or troubleshoot da… |
| 05-data-ai | **Reinforcement Learning Engineer** (`reinforcement-learning-engineer`) | Use when designing RL environments, training agents with reward optimization, implementing policy gradient met… |
| 06-developer-experience | **Build Engineer** (`build-engineer`) | Use this agent when you need to optimize build performance, reduce compilation times, or scale build systems a… |
| 06-developer-experience | **Cli Developer** (`cli-developer`) | Use this agent when building command-line tools and terminal applications that require intuitive command desig… |
| 06-developer-experience | **Legacy Modernizer** (`legacy-modernizer`) | Use this agent when modernizing legacy systems that need incremental migration strategies, technical debt redu… |
| 06-developer-experience | **Refactoring Specialist** (`refactoring-specialist`) | Use when you need to transform poorly structured, complex, or duplicated code into clean, maintainable systems… |
| 06-developer-experience | **Slack Expert** (`slack-expert`) | Use this agent when developing Slack applications, implementing Slack API integrations, or reviewing Slack bot… |
| 07-specialized-domains | **Blockchain Developer** (`blockchain-developer`) | Use this agent when building smart contracts, DApps, and blockchain protocols that require expertise in Solidi… |
| 07-specialized-domains | **Email Deliverability Engineer** (`email-deliverability-engineer`) | Use this agent when configuring email authentication, integrating transactional or marketing email providers, … |
| 07-specialized-domains | **Fintech Engineer** (`fintech-engineer`) | Use when building payment systems, financial integrations, or compliance-heavy financial applications that req… |
| 07-specialized-domains | **Hipaa Compliance** (`hipaa-compliance`) | Use when the user is building a healthcare product and needs to understand HIPAA compliance. Triggers on: 'HIP… |
| 07-specialized-domains | **M365 Admin** (`m365-admin`) | Use when automating Microsoft 365 administrative tasks including Exchange Online mailbox provisioning, Teams c… |
| 07-specialized-domains | **Payment Integration** (`payment-integration`) | Use this agent when implementing payment systems, integrating payment gateways, or handling financial transact… |
| 07-specialized-domains | **X Api Integration** (`x-api-integration`) | Use this agent when building X/Twitter data products, integrating X API alternatives, designing tweet search w… |

## 来源：[wshobson/agents](https://github.com/wshobson/agents) (MIT)

| 分区 | 专家 | 适用任务 |
|---|---|---|
| arm-cortex-microcontrollers | **Arm Cortex Expert** (`arm-cortex-expert`) | > |
| dgx-spark-ops | **Dgx Spark Ops Engineer** (`dgx-spark-ops-engineer`) | NVIDIA DGX Spark environment doctor for GB10/aarch64/CUDA-13 systems. Diagnoses and fixes ML stack setup, unif… |
| julia-development | **Julia Pro** (`julia-pro`) | Master Julia 1.10+ with modern features, performance optimization, multiple dispatch, and production-ready pra… |
| llm-finetuning | **Llm Finetuning Architect** (`llm-finetuning-architect`) | Fine-tuning strategist who owns the eval gate and method/model selection. Refuses to plan training without a b… |

## 来源：[jnMetaCode/agency-agents-zh](https://github.com/jnMetaCode/agency-agents-zh) (MIT)

| 分区 | 专家 | 适用任务 |
|---|---|---|
| marketing | **搜索增长编排器** (`marketing-search-growth-orchestrator`) | 编排 AEO 基础架构师、SEO 与自然搜索增长专家、AI 搜索可见性与 GEO 策略师，并在需要时移交智能搜索优化师，统一证据、任务边界、优先级、实施路线图与业务归因。 |
