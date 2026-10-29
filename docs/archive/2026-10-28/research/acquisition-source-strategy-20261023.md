# 获客首源策略：按公司具体产品使用海关与网页的落地结论

> 历史归档：保留原日期与当时结论，不作为当前实施步骤。现行说明见 [文档导航](../../../README.md)。

研究及最终补测日期：2026-10-23。当前版本替代本文件早期的宽关键词判断。

本任务只更新本报告。未采购服务、实施代码接入、修改数据库/飞书/Issue或发送开发信息；工作区其他任务的变更保留。全部调研由当前任务完成，未启用子代理。

## 1. 可以执行的决定

建议实施两条发现通道，共用主体核实、官网研究、去重和销售交接：

1. **北美面料/组件、plantation shutters：海关作为主要候选来源。** 先按公司官网实际产品查询逐票记录，从中归并真实买家，再核实官网和联系入口。
2. **定制成品零售/安装渠道、澳洲及英国本地企业：网页作为主要发现来源。** 海关用于补充相关进口证据、扩展上游买家；没有记录不阻止进入销售队列。
3. **样本册：独立的小型海关任务。** 商品描述辨识度高、买家少而直接，适合间歇刷新，不必每天重复扫描。
4. **户外 zip screen/pergola：网页发现为主、海关按系统和别名补充。** 本次已找到具体进口商，也验证了一个你提供的成交客户，但不足以证明该词包能稳定批量发现同类企业。

公司四个供货官网足以建立首版研究和发现词库。用户已明确以这些官网产品继续测试，**不再把另交“已审核产品目录”作为继续调研或实现发现模块的前置条件**。型号、尺寸和接口用于候选后的适配核实；正式报价和具体性能仍按真实产品资料处理。

不要把“按具体产品筛选”做成“每条海关描述都必须包含品牌型号、28mm或3%”。提单常只写产品类别和采购形态。本次3% sunscreen fabric仅2条，sunscreen fabric有118条；basswood slat虽仅2条，却直接找到AHD Blind Factory。正确入口是具体产品及采购形态，尺寸、材料、同义词和负例协助判读，而不是把所有参数强制拼成查询交集。

## 2. 363 credits 实际用在哪里

本轮开始时总使用637、剩余363。最终Credit Usage读回：**总额度1,000，已用1,000，剩余0**。

| 本轮动作                               |      成功返回 |    消耗 |
| -------------------------------------- | ------------: | ------: |
| 产品查询、补读第二页、成交客户提单核对 | 323条逐票记录 |     323 |
| Brite Blinds、Bumblebee Shades公司档案 |           2份 |      40 |
| Company Search Free、额度查询          |          免费 |       0 |
| 合计                                   |             — | **363** |

323条是计费返回数，跨查询去重后为306个供应商记录ID、291个非空B/L号码、149个供应商进口商ID；4条返回没有B/L。149个ID包含货代、境外电商、同一集团不同主体和待核实公司，不能当149家合格买家。291个B/L也不能直接当291次采购。

前轮73条产品逐票样本中的plantation shutter前50条、样本册8条等继续复用，未为重复读取前50条再付费。下表中的plantation shutter本轮只补付第二页23条。

### 实际查询台账

统一条件：type=imp；美国进口US、中国出口CN；2025-10-23至2026-10-23。单次页数/上限固定后取结果，未按核实后的公司好坏重排或替换样本。

| 查询                                            |            API匹配总数 | 本轮返回/credits | 观测结果                                                                       |
| ----------------------------------------------- | ---------------------: | ---------------: | ------------------------------------------------------------------------------ |
| zebra blind                                     |                     21 |               21 | OK Maison、Bumblebee、Stores et Toiles；含物流、杂货和组件                     |
| honeycomb blind                                 |                     20 |               20 | 物流/FBA较多；Bumblebee一票中主要还包括面料/组件与设备                         |
| basswood slat                                   |                      2 |                2 | AHD Blind Factory实际买家及对应物流层                                          |
| faux wood blind                                 |                    178 |               50 | Pacific Heritage、Action Window Coverings、Springs等；物流层和同B/L重复明显    |
| zipper blind / ziptrack blind / zipscreen别名组 |                      2 |                2 | The Awning Company及一条物流记录                                               |
| roller blind fabric                             |                    129 |               50 | Brite、Bumblebee、Luxa、Smartlux等；也误中普通杂货中的roller blind与其他fabric |
| motorized roller blind                          |                     10 |               10 | 编号公司、FBA、电商、物流与项目终端；未形成清晰可批量开发买家组                |
| cellular shade                                  |                     75 |               50 | 相比honeycomb扩大召回；大量DSV/物流，也有Springs、Achim、All Strong及大型渠道  |
| plantation shutter，第2页                       |                     73 |               23 | 补全全年窗口，出现持续重复买家                                                 |
| sunscreen fabric                                |                    118 |               60 | Brite、Maxxmar、Senbesta、Twitchell、Tribute、Novo、Enning等                   |
| blind components                                |                    207 |               34 | Coulisse Distribution、Tetakawi/Blinds To Go、Maxxmar、Novo等                  |
| 精确B/L KFUISZNEPS261341                        |                      1 |                1 | Shade Doctor of El Paso，aluminum pergola                                      |
| 合计                                            | 总数不可跨查询直接相加 |          **323** | —                                                                              |

轻量产品原文复核中：sunscreen fabric 60/60含对应产品字样，faux wood blind 50/50含对应字样，blind components 33/34含窗饰组件表达，roller blind fabric仅23/50符合预定卷帘/窗饰面料表达。该统计仅说明文本召回质量，不代表买家有效率；货代记录也可以有正确商品。

本轮并未对149个ID逐一完成官网和地址核实，因此不发布一个虚构的全体“合格买家率”。已经完整读了323条返回，并对下列有明确商业切入点的买家进行重点公开核实。

## 3. 公司官网可以直接转为首版产品查询表

| 公司官网产品依据                                                                                                                                                       | 首版产品包及采购形态                          | 召回词/扩展词                                                                                 | 后置判读                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| [Decor Max](https://decormaxgroup.com/)的basswood、fauxwood、aluminum、red cedar shutters；[BE产品中心](https://www.blindselements.com/products/)的plantation shutters | Plantation shutter整窗成品、型材/叶片另分机会 | plantation shutter；wood/PVC/basswood shutter                                                 | 材质、成品/组件、室内shutter与hurricane roller shutter分清          |
| [BE卷帘配件](https://www.blindselements.com/products/104.html)、[DuraRoll机构](https://www.durarollblinds.com/sujiaohanjieshebei_152-6.html)                           | 卷帘离合器、支架、卷管、制动/控制机构         | roller blind clutch；roller shade clutch；components of blind；bracket、head rail等返回后细分 | 官网公开管径28/32/38/43/50/63mm等用于后续适配；不要求报关原文有管径 |
| [DuraRoll材料](https://www.durarollblinds.com/material_170.html)                                                                                                       | 卷帘遮阳/遮光面料、斑马面料、蜂巢面料         | sunscreen fabric；roller blind fabric；blackout blind fabric；zebra blind fabric              | 排除weed barrier、服装布、普通家具布；开孔率/涂层/幅宽在匹配后核实  |
| 同上：25/35/50/63mm basswood、50mm fauxwood、25mm aluminum等叶片                                                                                                       | 横百叶叶片、半成品、系统配件                  | basswood slat；fauxwood blinds components；venetian blind slat                                | 成品、叶片与型材分别记录，不能只标“百叶客户”                        |
| Decor Max/BE的zebra、roller、honeycomb成品                                                                                                                             | 按尺寸成品与cut-down尺寸系列分别识别          | zebra blind/roller shade；honeycomb blind/cellular shade；faux wood blind                     | 包含安装零售渠道；不凭自产或本地制造排除整家公司                    |
| [BE户外电动系统](https://www.blindselements.com/products/89.html)、[配件](https://www.blindselements.com/products/87.html)及pergola目录                                | 户外防风拉链帘、系统、导轨、配件、凉亭        | outdoor zip screen；zipscreen；ziptrack/zipper blind；aluminum/louver pergola                 | 排除inflatable screen、zip ties、电子screen、普通roller shutter     |
| [Sampling Worldwide样本册](https://www.samplingworldwide.com/roller-shade_313.html)                                                                                    | 窗饰面料/卷帘样本册、样箱、展示册             | roller shade sample book；fabric swatch book；shade sample card                               | 明确是样本/展示采购，排除成品帘及不相干书刊                         |

Decor Max官网还列Moulding & Wall Panels。你提供的bldrsupply.com经营建材、门窗和millwork，与卷帘并非同一产品包；应保留其已贸易客户标签，再按实际成交产品归类。本轮没有花额度测试moulding，不据官网未展示卷帘否定这家客户。

HS独立作为补充通道。塑料帘及零件可涉及392530、纺织帘630392、涂层面料5903等；原始记录还会用不同层级或空码。以材料、用途和国家版本维护候选，不用一个HS包办所有产品，也不在默认请求中把HS与product强制取交集。

## 4. 买家核实后的可执行清单

以下“B/L数”只统计本次已读取样本里的不同非空号码，不是该公司的完整进口规模或采购订单数。网站相关性已经核实；具体交易主体自动合并仍应核对地址/别名。公司级入口足以用于销售接手，未把通用邮箱当采购负责人。

### 首批优先研究与交接

| 买家/官网                                                                                                          | 核实的经营与切入产品                                                  | 本次样本证据                                                                       | 公司联系入口/交接判断                                                                                       |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [Brite Blinds](https://www.briteblinds.ca/index.html) / [Components Division](https://britecomponents.ca/)；加拿大 | 本地工厂、卷帘/斑马系统和组件；优先面料、机构、组件                   | 2个B/L，2026-06-08、09-13；HNLTQD268Q0031；sunscreen/roller blind fabric           | blinds@briteblinds.ca；组件部门另有公开联系人。付费档案域名吻合，但国别错误，官网地址优先                   |
| [Bumblebee Shades](https://bumblebeeshades.com/)；加拿大                                                           | 加拿大本地制造；面料、轨道、支架、金属/塑料组件最直接                 | 2个B/L，02-28、08-05；MLILMNB26020774、MLILMNB26070928                             | 官网Get In Touch；付费档案无域名、邮箱、电话。需补交易地址后正式合并；避免误认美国Bumble Bee Blinds加盟品牌 |
| [AHD Blind Factory](https://ahdblindfactory.com/)；美国                                                            | 生产/加工窗饰，椴木叶片、仿木组件、五金                               | 09-02；SUSSPWL202607449；basswood blinds slat、fauxwood components                 | info@ahdblindfactory.com，770-475-6000；官网Alpharetta地址与产品可核                                        |
| [Luxa Blinds and More](https://luxablindsandmore.ca/)；加拿大                                                      | Calgary定制卷帘、斑马、蜂巢、电动，并称提供wholesale；先面料/卷帘供货 | 08-14；SGNAUZ26071282；roller blind / roller fabric                                | Info@Luxablindsandmore.ca，403-690-5754；与Lavish、ShadeMaster类型相近，值得优先业务核实                    |
| [Senbesta](https://senbesta.com/contact/)；美国                                                                    | 卷帘面料、组件、加工设备的专业渠道                                    | 2个B/L，05-17、10-05；HYSLFSZX09260949；sunscreen fabric                           | sales@senbesta.com，626-256-4800；优先具体面料系列，不把设备需求挪为我方设备能力                            |
| [Stores et Toiles en Ligne](https://stores-toiles.ca/)；加拿大                                                     | 本地工坊、卷帘/斑马等；面料与离合器契合                               | 07-18；THGLNBO26070389；3% sunscreen fabric、roller blind clutch、ready-made zebra | info@stores-toiles.ca，1-855-658-9075；官网Québec及G1P 1K7可核，需交易地址进一步闭合                        |

### 成品、样本与规模型买家

| 买家/官网                                                                    | 贸易证据与最合适的开发方向                                                                    | 处理方式                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [The Shade Home](https://theshadehome.com/about-us.php)；美国                | 完整73条plantation查询中该名14条、13个非空B/L，2025-10-29—2026-09-10；WOOD PLANTATION SHUTTER | 成品shutter优先；info@theshadehome.com，209-834-5264。记录数与B/L数不同，不能直接当14次采购                                                                                                                             |
| [The Shutter Store](https://www.theshutterstore.com/information/faqs/)；美国 | 10个B/L，2025-11-14—2026-09-19；官网明确北美和中国制造伙伴                                    | 成品/OEM渠道，官网Contact；已有稳定供应链是适配证据，新增供方开放度待业务核实                                                                                                                                           |
| Shutter Guys Inc.；美国                                                      | 9个B/L，2025-11-06—2026-09-18；HYSLNTAO12250686等                                             | shutter成品线索；[企业业务资料](https://www.bbb.org/us/ca/escondido/profile/shutters/the-shutter-guys-1126-21006832)有对应公司与电话，正式交接前再核对交易地址                                                          |
| [Maxxmar](https://www.maxxmar.com/)；加拿大                                  | 已读样本4个B/L，2026-01-27—09-26：面料、组件、样本册                                          | 同家公司保留三类机会；Info@Maxxmar.com、416-742-6299；不能因加拿大制造而排除进口组件/样本                                                                                                                               |
| [Pro Design](https://www.prodesignllc.net/)；美国                            | 前轮样本册3条记录只有2个B/L；MWQTZRL06127在不同日期/港口重复                                  | 样本册/展示更新切入；info@prodesignllc.net、330-562-0023；其[官方说明](https://support.prodesignllc.net/support/solutions/articles/22000295739-pro-design-llc-name-on-headrail-label-faq-general)明确importer of record |
| [Twitchell](https://www.twitchellcorp.com/)；美国                            | 3个B/L，06-06—09-24；sunscreen fabric；MCLMGZSAV2608A01                                       | 面料渠道或供应配套；334-792-0002；自有技术/制造能力不消除外购机会，具体系列适配需核实                                                                                                                                   |
| [Tribute Window Coverings](https://www.twcltd.ca/about)；加拿大              | 09-28；BSVVBMS2608096；sunscreen/blackout fabric、roller blinds fabric catalog                | 专业面料与系统渠道；info@twcltd.ca、905-602-6377；同名美国主体另核，不能自动合并                                                                                                                                        |
| Action Window Coverings；美国                                                | 08-19、08-20两个B/L；50mm faux wood cordless blind                                            | 具体成品适配强；[行业协会](https://members.texasbuilders.org/associate-directory/Details/action-window-coverings-inc-731020?rendermode=print)核到281-351-5553及官网域名，现官网抓取失败，留人工复核                     |
| Pacific Heritage Home Fashion；美国                                          | 已读样本16条、15个B/L；2英寸PVC cordless fauxwood成品及roller blind组件                       | 有真实批量需求，但较大渠道/供应商体系，优先级低于容易确认适配的中型买家；公开品牌[联系页](https://www.facebook.com/pacificheritagehomefashion/about)需与公司地址继续核实                                                |
| The Awning Company                                                           | zipscreen别名组命中05-20；TXSLF2026042090；louver pergola与zipscreen blinds                   | [候选官网](https://theawningcompanyca.com/)经营pergola/awnings且公开sales@邮箱；记录名含MR. GARY J、官网资料有Gary Kerr，**身份尚未闭合**，先补交易地址，不计为已核实自动交接买家                                       |

Coulisse Distribution在组件34条中有2个B/L，Tetakawi/Blinds To Go有4个。它们适合规模型账户专项研究；Coulisse B.V、Distribution及制造/贸易服务主体需分清，不能因为共享某个B/L就把所有名称合成一家公司。

这份清单是产品贸易事实和经营匹配的研究结果，没有向其中任何企业发信。采购数量、MOQ、替换现供方意愿和采购负责人未被凭空补齐。

## 5. 用你的真实客户校准：海关能覆盖什么，不能漏掉什么

用户提供的“已有贸易”标签作为已知业务事实保存；“最近运营沟通”另存关系状态，不把官网研究结果反过来否定它们。去重整理后共21个入口，其中含一个YouTube频道以及少数疑似拼写/不可抓取域名。

### 六个已有贸易客户

| 用户提供客户                                                      | 官网核实与产品机会                                                | 本次海关核对及影响                                                                                                                                                |
| ----------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Lavish Blinds](https://lavishblinds.ca/)；加拿大                 | 定制roller、zebra、cellular、motorized、shutter等，具测量安装流程 | Company Search Free名称Lavish Blinds返回0；保留成交客户，继续通过网站发现同类渠道                                                                                 |
| [Smart Shades Utah](https://smartshadesutah.com/)；美国           | 卷帘、shutter、自动帘、按尺寸制造和安装，联系方式公开             | Smart Shades名称查询返回0；说明该库单一品牌名检索无法覆盖全部目标客户                                                                                             |
| [Save On Blinds](https://saveonblinds.com/pages/about-us)；加拿大 | 同时有国际/国内供应商和本地生产；面料、组件与非自产成品分别研究   | Save On Blinds、Rightlook名称查询均0；本地制造不构成排除条件。品牌/交易主体可参考[行业组织记录](https://hub.chba.ca/member-directory/Search/on-562753?cid=562764) |
| [Builders Supply](https://bldrsupply.com/)；美国                  | 建材、门窗、trim/moulding；不能套用卷帘主营                       | 主体名称太泛，本轮未作自动海关匹配；按实际成交产品和Decor Max目录另建机会                                                                                         |
| [Shade Doctor of El Paso](https://shadedoctorelpaso.com/)；美国   | 户外电动遮阳、solar screens、awnings等                            | 免费名称查询命中SHADE DOCTOR OF EL PASO LLC；精确B/L回查成功，见下文                                                                                              |
| [ShadeMaster](https://shade-master.ca/)；加拿大                   | 卷帘、斑马、仿木、电动；本地测量安装和选样                        | Shade Master带空格名称查询0；未穷举全部法定别名，不写“无进口”                                                                                                     |

Shade Doctor实测记录：B/L **KFUISZNEPS261341**，日期2026-03-01，发货人WAYNE(HANGZHOU) BUILDING MATERIALS，收货人SHADE DOCTOR OF EL PASO LLC，原文S.T.C.ALUMINUM PERGOLAHS CODE :，1 PKG、260 KG、金额0、HS空，Yantian至Long Beach。[当地商会](https://members.elpaso.org/active-member-directory/Details/shade-doctor-4498087)与官网支持El Paso身份和户外经营。

该票先由公开贸易索引提供B/L，再在本供应商逐票接口中回查，属于**已知客户正向核对，不算盲测发现成功**。它证明pergola是应纳入的实际产品包，以及公司业务客户可以对应很具体的一票；不能据此声称B路线找回了六个成交客户。

### 最近沟通客户对获客规则的校准

- [Flash Blinds](https://flashblinds.com.au/)、[Parker](https://www.parkerblindsandcurtains.com.au/blinds)、[Welcome Blinds](https://welcomeblindsandcurtains.com.au/)：成品与户外渠道，产品广、量尺安装明显。Parker明确部分卷帘来自本地制造商和既定面料品牌；这些是采购路径核实项，保留运营沟通状态，不直接排除。
- [Soho Blinds](https://sohoblinds.ca/)：加拿大本地制造并销售多种帘型，优先组件/面料与其未自产的成品。
- [The Little Blinds Shop](https://www.thelittleblindsshop.co.uk/)：多类定制帘、manufacture与fit流程，英国网页发现为主。
- [Baja Blinds](https://www.bajablinds.com/)：跨境业务、卷帘、shutters、横百叶和motorized，适合成品/组件分开调查。
- [UpThrone](https://www.upthrone.com/)：多品类帘、轨道、电动；官网当前有Rosenberg联系入口。前次资料存在模板/地址冲突，人工核对后再与交易主体合并。
- [Curtain Outlet Northbridge](https://curtainoutletnorthbridge.com/)与[Saaria](https://www.saaria.com/)：前者布艺/纱帘/valance，后者舞台幕布和轨道更明确。按相应布艺/轨道/样本方向研究，不能全套卷帘条件。
- cactusflowerblindsandshades.com本轮只提取到Square支付页外壳；fantasticblinds.com.au、houseoflabon.com、awindowpros.com、glamourwallpareanddraper.com未取得足够可核正文；保留用户给的沟通记录与原始域名，暂不做自动身份断言。
- youtube.com/@helloentretainment保留为社媒入口；尚未核定法律主体、窗饰经营和公司域名，不自动创建一个与其他记录分离的已验证买家。

落地规则：以已有成交和沟通事实指导发现画像；允许本地安装商、经销商、零售/项目服务商、自有工厂；按具体采购形态判适配。海关覆盖不全、品牌与交易主体不同、空运/陆运等，都可能导致名称查不到。上述名称零返回只限本供应商、当前默认窗口及实际输入方式。

## 6. 产品级数据揭示的供应商限制

### 国别必须拆开

Brite的20-credit档案返回country=US、domain=briteblinds.ca、进口国家同时含US和CA；官网明确加拿大工厂。Bumblebee档案也标US，但官网与企业自述在加拿大。美国逐票源中出现Maxxmar、OK Maison、Brite等加拿大经营买家。

因此数据库至少分别存：记录披露/进口市场、买家经营国、买家交易地址、发货方国别、装港国、制造原产地（有依据才填）。不能直接把接口country复制为客户市场。

部分CN过滤记录的发货人名称或描述涉及Vietnam、Cambodia、Malaysia，且同时给中国装港/源国字段。该供应商字段不能独立证明制造原产地，更不能未经核实计算“中国采购占比”。采购路径保留原文；来源国不作为准入硬门槛。

### 去重要保留层级

Pro Design同一B/L在不同日期/港口出现；The Shade Home14条只有13个非空B/L；Pacific Heritage16条为15个B/L。组件查询中同一B/L还可能连接不同交易角色。

先按供应商record ID去重，再以B/L、角色、主体、商品明细聚类；保留Master/House与可能转运关系。相同B/L的不同主体不能简单删除或强合并。缺Master/House定义、无唯一明细或单位混乱时，只展示“观察到的记录/B/L/活跃月份”，不称采购次数。

### 公司档案不能替代官网核实

2份档案合计40 credits：Brite给出正确域名，但电话/邮箱均空、国家错误；Bumblebee域名为“-”、电话/邮箱也空。**不建议每个候选默认花20 credits开档案。**

优先用1-credit逐票记录、免费公司ID检索和官网；只对名称/品牌冲突或需要明确新增字段的少数主体查看付费档案。该服务的联系人产品本轮没有contact credits，未测试采购人员效果。

### 文本与角色过滤是必需的

该API产品词存在分词宽匹配：roller blind可命中roller bearing与blind rivet；outdoor zip screen可命中zip ties与outdoor inflatable screen；blind components出现blind flange/valve。前轮Check Logistic对Amazon Logistics和Globe Express返回false，同一主体is_shipping也不一致。

生产实现应把产品原文匹配、用途、采购形态、物流身份和买家主体分别判断；单一is_shipping=false不能放行。金额0保留未知，不能据此判小客户。

## 7. 按市场启用方式

| 市场/目标                                    | 首源与补源                                         | 直接可执行的处理                                                                   |
| -------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 美国披露记录覆盖的北美材料/组件、shutter买家 | 海关先发现，官网核实                               | 从上述已成功词包开始，按买家经营地分流US/CA；不以进口口岸替代客户国家              |
| 加拿大本地定制渠道                           | 网页主发现 + 美国逐票中加拿大买家 + 官方进口商名单 | 保留Lavish/Save On/Soho类型；追加官方HS进口商发现                                  |
| 澳洲成品/户外渠道                            | 网页主发现                                         | 依据Flash/Parker/Welcome等真实客户画像扩展，不能用这个供应商的镜像数据推断没有进口 |
| 英国定制渠道                                 | 网页主发现，具名进口商资料补充                     | The Little Blinds Shop类型可直接研究；本供应商英国公开字段较少，尚未做逐票效果测试 |
| 其他市场                                     | 按国家与产品分别验证                               | 原生逐票、具名汇总、镜像贸易分别使用；不套统一“欧洲/全球海关”规则                  |

**加拿大的重要补充**：此前仅根据BillOfLadingData的mirror覆盖把加拿大整体判为不能按产品发现买家，范围过窄。加拿大官方[ISED Canadian Importers Database](https://ised-isde.canada.ca/site/ised/en/research-and-business-intelligence/canadian-importers-database)提供按产品、城市、来源国查企业名与城市/邮编；其页面说明名单含broker、客户和非居民进口商，主要进口商口径为合计至80%进口份额。页面产品概览标2024数据，部分分项仍标2023，不能当2026逐票流。

本轮打开了[官方产品检索入口](https://ised-isde.canada.ca/app/ixb/cid-bdic/searchProduct.html?lang=eng)，具体目录页读取超时；未虚构某HS下的实际企业命中数。可把该官方源作为下一批免费/公开名单补源，保留数据年份；美国逐票发现加拿大买家的能力已在本轮实际验证。

## 8. 开发时直接采用的流程与默认参数

```text
四个公司官网 → 具体产品/采购形态/别名/负例词库
  ├─ 网页发现：目标市场 × 真实客户同类经营模式
  └─ 海关发现：产品逐票 + 独立HS补充
       → record ID去重 → B/L/角色聚类 → 真实买家候选
       → 官网/交易主体/实际经营国/公司联系入口核实
       → 同一企业合并，分别保留成品/组件/面料/样本机会
       → P/R/D/V初评 + 独立海关证据 → 销售交接
```

首版不需要一个新“Top Importers搜索页”。在现有获客任务内增加来源customs，产品继续使用既有选择；后台根据上述产品表产生词包，运行记录展示实际词、时间窗、返回条数、credits、去重B/L、排除物流、核实买家和新增/更新数。

建议的首批运行配额是运营起点，不是假称已经过转化实验优化：

- 每周一次，近12个月发现基线；持续运行后优先刷新近30天并复用已有企业研究。
- 每轮逐票上限300 credits，单页最多50，避免与公开Micro包每次50条的上限冲突；本次试用页面虽允许60，也不据此假定生产套餐无限。
- 初始分配：面料100条、组件/叶片75条、plantation shutter75条、样本20条、户外30条。某包无新结果就把剩余额度转给有新买家的包；不为凑数重复购买。
- products内部同义词并集；product与HS分别查询后合并。必须记录查询条件和版本；多个查询命中同一记录仍可能重复计费。
- 全球来源先保留，已有中国供应链另标证据；出口国CN仅作一条队列，避免让字段噪声和来源限制把买家排掉。
- 原文过滤排除明显非目标用途；物流进入证据关联，不进入销售买家计数；编号公司和冲突主体进入待核实，不硬凑域名。
- 默认不调用All Importers和付费Company Details；官网证据与免费公司检索优先。
- 以本次已核实买家作正例，以Amazon/Globe Express/Chain Logic、blind flange、inflatable screen、FBA境外主体作负例；不能把正例公司名称硬编码成仅允许名单。

### 第一批实施任务

1. 从四个供货官网固化产品词包与页面证据，扩展现有产品目录元数据；不等待新一轮人工重做目录。
2. 接Shipping Records、免费Insights/Company Search和Credit Usage；保存查询快照与硬额度上限。
3. 实现record ID/B/L/角色层级去重、物流分流、买家市场与口岸市场拆分；展示冲突状态。
4. 复用现有官网研究、P/R/D/V评分、联系方式和企业归档，增加具体贸易原文、B/L、日期、供货形态与来源窗口。
5. 用本次首批6家重点买家、3家shutter买家及6个用户已贸易客户验收；成交客户即使海关零命中也仍保留。
6. 再接加拿大官方HS名单与其他市场；不要把跨国原产地/金额汇总放在第一批阻塞候选发现。

沿用[评分v3](../acquisition-scoring-v3.md)与[海关导入规格](../customs-import-spec.md)：海关不改100分初评。先区分未知、候选关联、已核实相关贸易、近期/持续贸易；没有记录不扣业务初评分。“当前愿意新增供应商”由RFQ、招募或真实沟通支持，不能由进口频率代写。

## 9. 成本与供应商选择

[当前公开价格](https://billofladingdata.com/api-pricing)：逐票1 credit，聚合公司15，完整档案20；生产一次性激活499美元，Micro 25,000 credits为59美元，12个月有效。300条逐票边际约0.708美元，363 credits约0.857美元；首次499美元是主要固定门槛，不能只拿几毛钱边际成本做采购判断。网站、模型和人工核实成本另计。

本次已花完赠送额度，现有证据足以决定首批产品和工程路线，**不需要为得到结论再开账号取赠送额度**。若进入采购，建议只考虑最小生产包/官方试用扩容；支付前核清实际API记录字段与Master/House定义、生产分页上限及签约适用条款。主站[条款](https://billofladingdata.com/terms)允许内部获客/CRM/AI等用途，但门户页脚链到Zari，需明确适用关系。

对BillOfLadingData的采购判断：**可作为低边际成本的北美逐票候选源，不能作为完整CRM、准确企业国别或采购联系人库购买。** 暂不扩大到大包；首个生产月以300条/轮的受控发现验证新增买家、人工耗时和销售接手，发现增长饱和后降低刷新频率。若多数预算持续花在重复物流或无法核实主体，暂停该词包，并保留其他已经有效的产品包。

评估统一记录：返回记录数、商品原文相关数、去重B/L数、去重买家、主体已核实数、有入口数、新增/既有更新、每个新核实买家的实际credits和研究耗时、销售接手及后续合格对话。要比较A/B带来的合格对话，应按同市场同产品轮换来源；本次没有外联实验，不编造回复/成交提升。

## 10. 前轮证据保留及结论边界

- 前轮20家官网样本17家严格业务相关；本地roller blind工作簿20家候选中11家严格有效。它们不是与本轮同条件的随机A/B样本。
- 前轮36条All Importers聚合记录、33家公司只有6家明确目标，保留为宽词/角色压力测试，不用于否定产品级逐票B路线。
- 本地文件C:\Users\Johnson\Desktop\海关数据\roller blind.xlsx的INFO!C1:C4：美国House进口、商品roller blind\*、2025-01-01—2026-10-18、2,234行；DATA!A1:U2235缺唯一B/L、金额和重量单位。详见原样本核对（原引用 customs-sample-findings.md 未随本仓库保存）；不把行数当采购次数。
- 供应商的[国家目录](https://billofladingdata.com/countries)、[方法](https://billofladingdata.com/methodology)与[质量说明](https://billofladingdata.com/data-quality)只描述覆盖，不替代本产品实际测试。
- 当前结论是产品、数据源与工程路线可行性判断，尚未实装海关接入，也没有外联转化数据。最需要继续验证的是实体地址、Master/House口径和销售实际接手，已不缺“大类选择”层面的讨论。

**最终建议：现在实施“海关发现北美面料/组件和shutter买家，网页发现定制成品渠道，共用官网核实与销售交接”的双通道。四个供货官网直接提供产品词库；六个成交客户提供校准事实；按具体产品和采购形态运行，保留加拿大跨美国口岸的真实买家，不以海关查不到淘汰已有或潜在客户。**
