// 基于 2026-10-19 在用户已登录的 n8n 编辑器中核对的节点名称。
// 只用于业务流程说明，实时状态与结果只能由服务端 API 获取。
export const workflowStages = [
  {
    id: 'target',
    title: '定义目标',
    en: 'TARGET',
    description: '接收国家、州、城市、产品与获客渠道',
    nodes: ['Manual Trigger', 'ShadeFlow API Webhook', '配置搜索目标'],
  },
  {
    id: 'discover',
    title: '发现客户',
    en: 'DISCOVER',
    description: '已有客户域名预处理，搜索并选出独立官网',
    nodes: [
      '获取飞书Token',
      '读取已有客户',
      '整理已知域名',
      'Tavily Search',
      '选择一个独立企业官网',
      '找到官网?',
    ],
  },
  {
    id: 'research',
    title: '研究官网',
    en: 'RESEARCH',
    description: '提取官网内容，检查正文是否足以支撑画像',
    nodes: ['Tavily Extract', '检查正文', '正文有效?'],
  },
  {
    id: 'qualify',
    title: '画像评级',
    en: 'QUALIFY',
    description: '调用 Dify 处理并解析结构化研究结果',
    nodes: ['调用Dify Workflow', '解析结果', '最终结果', '可入库?'],
  },
  {
    id: 'sync',
    title: '去重入库',
    en: 'SYNC',
    description: '按身份键查询，分流新增、更新或不写入',
    nodes: [
      '读取表字段',
      '构建飞书记录',
      '可查询?',
      '按身份键查询',
      '判定写入方式',
      '写入分流',
      '逐条写入',
      '新增飞书记录',
      '更新飞书记录',
      '核对写入结果',
      '入库汇总',
    ],
  },
];
