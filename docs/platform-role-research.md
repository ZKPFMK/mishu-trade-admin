# 平台调研入口与早期四平台研究

调研日期：2026-11-03。范围：公开官方文档、公开控制台入口，以及 MiShu 当前代码。未登录这些厂商的客户控制台，也未体验其内部员工后台；文档中的客户工作区不能直接视为厂商内部管理系统。本文将已核实事实与 MiShu 设计建议分开。

**完整调研请阅读 [MiShu 数据与数字内容交易平台调研报告](platform-benchmark-report.md)，城市数据交易所的深度比较请阅读 [城市数据交易所深度比较与 MiShu 平台目标形态](data-exchange-city-comparison.md)。本文下半部分为早期四平台专题，保留供历史参考。** 完整报告包含 60 个候选索引、23 个代表平台分析、七个城市数据交易所比较、现有方案复核及实际使用任务书。实际操作因浏览器连接及 Chrome 控制授权受限，尚未完成。

## 60 个候选平台分类索引

下面完整列出此前的 60 个候选，方便直接打开网站。候选清单不等于已完成逐站调研：23 个平台已在完整报告第 3 节展开资料分析，37 个仍是候选索引；全部平台的实际操作验证尚未完成。逐项证据状态见完整报告附录 A。

| 分类                     | 数量 | 平台入口                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------ | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 数据交易与共享           | 17   | [Snowflake Marketplace](https://docs.snowflake.com/en/user-guide/data-exchange-marketplace-privileges)、[Databricks Marketplace](https://docs.databricks.com/aws/en/marketplace/manage-requests-provider)、[AWS Data Exchange](https://aws.amazon.com/data-exchange/)、[BigQuery sharing](https://docs.cloud.google.com/bigquery/docs/analytics-hub-introduction)、[Datarade](https://datarade.ai/)、[Dawex](https://www.dawex.com/en/solutions/data-marketplace/)、[Monda](https://www.monda.ai/)、[Defined.ai](https://marketplace.defined.ai/datasets)、[Narrative](https://www.narrative.io/infrastructure/data-marketplace)、[SAP Datasphere](https://help.sap.com/docs/SAP_DATASPHERE)、[上海数据交易所](https://dtxp.chinadep.com/)、[深圳数据交易所](https://www.szdex.com/portal/)、[北京国际大数据交易所](https://www.bjidex.com/platform/product)、[贵阳大数据交易所](https://www.gzdex.com.cn/)、[杭州数据交易所商城](https://mall.hzdex.cn/)、[海南国际数据交易所](https://www.datadex.cn/home)、[浙江数据交易相关入口](https://market.aliyun.com/dataexchange-center)                                                                                                                                   |
| AI 与内容生成            | 16   | [ElevenLabs](https://elevenlabs.io/docs/overview/administration/workspaces/members)、[火山方舟](https://console.volcengine.com/ark/region:cn-beijing/docs/platform-capabilities-overview)、[阿里云百炼](https://help.aliyun.com/zh/model-studio/permission-management-overview)、[百度千帆](https://ai.baidu.com/ai-doc/WENXINWORKSHOP/7lx0cauid)、[腾讯智能体开发平台](https://cloud.tencent.com/document/product/1759/105796)、[硅基流动](https://www.siliconflow.cn/)、[Hugging Face](https://huggingface.co/docs/hub/organizations-security)、[Replicate](https://replicate.com/docs/topics/organizations)、[fal](https://fal.ai/enterprise-hub)、[OpenRouter](https://openrouter.ai/docs/cookbook/administration/organization-management)、[Together AI](https://docs.together.ai/docs/roles-permissions)、[Fireworks AI](https://fireworks.ai/product)、[Mistral](https://docs.mistral.ai/admin/identity-access/roles-permissions)、[Runway](https://help.runwayml.com/hc/en-us/articles/43200006470163-Role-permissions-table)、[HeyGen](https://help.heygen.com/en/articles/9468098-collaboration-and-access-control-with-workspaces)、[Synthesia](https://docs.synthesia.io/docs/user-roles-and-permissions) |
| 数据治理与资产发现       | 5    | [Atlan](https://atlan.com/atlan-demo/)、[Collibra](https://www.collibra.com/tour)、[Alation](https://www.alation.com/product/data-products-marketplace/)、[DataHub](https://datahub.com/resources/product-demos/)、[OpenMetadata](https://sandbox.open-metadata.org/)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| API 服务市场             | 4    | [RapidAPI / Nokia API Hub 相关入口](https://rapidapi.com/)、[APILayer](https://marketplace.apilayer.com/)、[聚合数据](https://www.juhe.cn/)、[阿里云 API 市场](https://market.aliyun.com/data)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 支付、电商与市场基础设施 | 8    | [Stripe](https://stripe.com/blog/stripe-organizations-powering-the-worlds-most-complex-businesses)、[Adyen](https://docs.adyen.com/account/user-roles)、[Airwallex](https://www.airwallex.com/docs/payouts/transfers/manage-transfers/manage-approvals-for-transfers)、[Shopify](https://help.shopify.com/en/manual/your-account/users/roles/)、[Medusa](https://medusajs.com/admin)、[Saleor](https://saleor.io/start)、[Sharetribe](https://www.sharetribe.com/help/en/articles/8501778-how-sharetribe-console-works)、[Mirakl](https://www.mirakl.com/products/marketplace-platform/)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 数字商品与创作者交易     | 10   | [Gumroad](https://gumroad.com/help/article/326-teams-and-roles)、[Lemon Squeezy](https://docs.lemonsqueezy.com/help/online-store/teams)、[Adobe Stock](https://helpx.adobe.com/stock/contributor/get-started/manage-your-account/adobe-stock-contributor-overview.html)、[Shutterstock](https://submit.shutterstock.com/)、[Pond5](https://contributor.pond5.com/)、[Fab](https://dev.epicgames.com/documentation/fab/publisher-get-started-in-fab)、[Unity Asset Store](https://assetstore.unity.com/publishing/publish-and-sell-assets)、[Artlist](https://help.artlist.io/hc/en-us/articles/29556902963613-Managing-an-Artlist-Music-SFX-or-Max-team)、[Epidemic Sound](https://www.epidemicsound.com/pricing-and-plans/)、[Civitai](https://civitai.tech/creator-program)                                                                                                                                                                                                                                                                                                                                                                                                                                         |

## 以下保留早期四平台研究

原文仅针对四个平台的账号、权限和工作区问题，不代表完整调研范围。最新综合判断、功能优先级和实际体验待办以 [完整报告](platform-benchmark-report.md) 为准。

## 选型理由

用户指定的 ElevenLabs、火山引擎主要提供 AI 产品与云服务，适合参考多人协作、资源授权和管理配置。补充 Snowflake Marketplace 与 Databricks Marketplace，参考真正的数据产品供给、消费、请求处理与交易权限。四个平台的业务并不完全相同，因此不按页面外观直接复制。

## 1. ElevenLabs：成员身份、产品使用与资源权限分层

官方文档确认：

- 工作区管理员负责成员、权限及订阅管理。Enterprise 工作区可给非管理员叠加 User Manager、Resource Manager 等成员角色；这些能力不是同一种管理权限。[成员与角色](https://elevenlabs.io/docs/overview/administration/workspaces/members)
- 资源共享可面向用户、用户组或服务账号。资源 Viewer 能查看并使用资源，例如生成语音；Editor 增加编辑能力，Admin 增加删除及共享管理能力。因此不能把其 Viewer 直接等同于 MiShu 的业务只读账号。[资源共享](https://elevenlabs.io/docs/overview/administration/workspaces/sharing-resources)
- 用户可以属于多个用户组，并获得这些组的权限并集；组还可控制特定产品功能。[用户组](https://elevenlabs.io/docs/overview/administration/workspaces/user-groups)
- 审计日志读取有单独的 `audit_log_read` 权限要求，文档说明该能力面向 Enterprise 工作区。[审计日志](https://elevenlabs.io/docs/overview/administration/workspaces/audit-logs)

对 MiShu 的建议：人员管理、业务处理、审批、审计应分别表达；账号身份和应用范围必须可见。一个人可拥有多个角色，但管理员身份不能自动赋予财务审批权。无需引入其套餐、席位与计费模型。

## 2. 火山引擎 / 火山方舟：独立子用户与资源范围

官方文档确认：

- IAM 用户有自己的身份与登录设置；可启用密码登录控制台或访问密钥访问 API，再分配策略或加入用户组。[用户管理](https://docs.volcengine.com/docs/iam/user-management?lang=zh)
- 火山方舟建议多人使用时建立子账号并按用途授权；示例中的 `ArkReadOnlyAccess` 允许查看方舟资源，禁止资源操作。[平台能力速览](https://console.volcengine.com/ark/region:cn-beijing/docs/platform-capabilities-overview)
- 项目权限可以限定身份能够操作的资源范围；全局授权与指定项目授权有明确区别。[管理项目权限](https://docs.volcengine.com/docs/resource-management/project-permission-management?lang=zh)
- 火山引擎存在 IAM 用户专用登录入口，要求主账号名或 ID、子用户名等身份信息。因此不能声称所有成熟平台都只有一个完全相同的登录表单。[公开 IAM 登录页](https://signin.volcengine.com/auth/login/user/)

对 MiShu 的建议：当前规模沿用统一邮箱登录，每个人一个账号，通过认证后决定可进入的工作区和授权应用。角色不同不构成建设五套认证服务的理由。应用范围仍由服务器校验；登录页不能让使用者自行选择并获得角色。

## 3. Databricks Marketplace：消费与供给分别组织任务

官方文档确认：

- 浏览或消费数据产品与供应商管理是不同任务；进入 Provider console 需要 Marketplace admin 角色。[成为供应商](https://docs.databricks.com/aws/en/marketplace/become-provider)、[消费数据产品](https://docs.databricks.com/aws/en/marketplace/get-started-consumer)
- 供应商在 Provider console 的 Overview 查看新请求，在 Consumer requests 管理请求；履约还需要相应 recipient 权限。请求可以处于 pending、fulfilled、denied 等状态。[处理数据产品请求](https://docs.databricks.com/aws/en/marketplace/manage-requests-provider)
- 供应商分析报表与请求处理是不同入口，报表需要相应系统表和计算资源访问条件。[使用分析报表](https://docs.databricks.com/aws/en/marketplace/manage-requests-provider#monitor-listing-usage-metrics-using-dashboards)

对 MiShu 的建议：默认首页应直接回答“我接下来处理什么”，任务列表应提供对象、状态和下一步入口。运营、审批和审计工作区按工作组织，共用获授权的订单或流水详情。不把数据消费方/供应商误当作当前五种内部员工角色。这里的数据访问申请流程也不能代替 MiShu 的财务双人审批。

## 4. Snowflake Marketplace：浏览、购买、发布与管理分别授权

官方文档确认：

- Data Exchange 的成员管理、listing 与 provider profile 审核可授权给其他角色，授权范围限于对应的 Data Exchange。
- 创建 listing、创建 share、购买付费 listing、查看 listing、修改 listing 分别对应不同权限；Provider Studio 提供 listing 管理及授权入口。[交易市场与 Data Exchange 权限](https://docs.snowflake.com/en/user-guide/data-exchange-marketplace-privileges)

对 MiShu 的建议：能查看业务记录，不自动意味着能导出、发起退款、审批或管理成员。菜单、页面、API 和后台任务都应使用明确能力；对象详情里嵌入的工单、审批记录也要检查相应读取权限。

## 证据支持的共同方向与边界

| 设计问题                       | 调研支持的方向                                         | 对 MiShu 的处理                                         |
| ------------------------------ | ------------------------------------------------------ | ------------------------------------------------------- |
| 五个人是否应共用一个账号       | 独立成员或子用户有独立身份与授权                       | 每位实际工作人员一账号，五岗位账号继续用于体验          |
| 是否必须五个登录网址           | 不同平台的入口方式不同，不能得出统一要求               | 保留统一入口，账号决定权限和默认工作区                  |
| 是否所有页面都应不同           | 公开文档证明任务和权限可分，未证明每种角色都有独立首页 | 岗位首页不同，获授权的订单等详情可以共用                |
| 只隐藏按钮是否足够             | 权限细分到动作和资源                                   | 同时约束菜单、路由、API、任务及导出下载                 |
| 管理员是否自然拥有全部业务权力 | 各平台管理员含义不同，不能直接套用                     | 维持 MiShu 运营与审批职责分离，不增加管理员隐式资金权限 |
| 外部买家/卖家是否等同内部岗位  | Marketplace 供需工作流与内部管理不同                   | 外部交易门户另立需求，不混入本轮五岗位后台              |

**设计推导**：MiShu 适合采用“统一身份认证 + 岗位工作区 + 明确能力 + 应用范围”。这是基于调研和本仓库约束形成的设计建议，不是以上平台共同承诺的某套首页模板。

## 与当前 MiShu 的差距

以下为代码审阅结论，未在本次调研中重新执行运行态权限测试：

1. `apps/admin/src/main.tsx` 的导航仅对人员与审计页做角色过滤；所有角色的 `overview` 都加载 `Workbench` 与业务分析，解释了用户看到的首页雷同。
2. `packages/core/src/worklists.ts` 只对待审批、我的工单两类计数分角色，其余工单、未知结果、对账差异计数向全部获授权用户返回。
3. `apps/api/src/app.ts` 的许多读取接口仅检查登录与应用范围；订单详情还聚合流水和运营申请。以后缩小岗位读取范围，必须同步约束聚合响应，不能只检查独立列表。
4. 导出任务创建目前未像其他任务那样限制岗位。若将“运营查看”定义为只读且不可批量导出，这是一次明确的授权调整，必须覆盖创建、状态查询和下载三个环节。
5. 当前 `roles` 属于用户，`scopes` 独立列出应用；不是“每个应用配置不同角色”。本轮沿用该模型，不能在界面暗示已经实现按应用分配不同角色。
6. 当前页面选择在不可见路由上回落到默认页，但 URL 未相应规范化；导航记忆按应用与页面保存。需要补上用户隔离、账号切换与会话失效验证。

## 下一步方案

本次只落地调研与修订计划，尚未改变运行中的页面、账号或权限。具体岗位矩阵、三轮方案自审及隔离验收要求见 [岗位工作区改造计划](role-workspaces-plan.md)。上一期运营工作台交付仍有效；其共同首页设计由新计划接续改造。
