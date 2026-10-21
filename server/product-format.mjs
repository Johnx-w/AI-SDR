// Display translations only: the original website product wording remains in facts.
export function formatRelatedProducts(value) {
  const catalog = [
    ['Zip Screens', '户外拉链遮阳帘：手动/电动', ['Zip Screen 户外拉链遮阳帘(手动/电动)']],
    ['Plantation Shutters', '种植园百叶窗', ['Plantation Shutters 种植园百叶窗']],
    ['Folding Arm Awnings', '曲臂遮阳篷', ['Folding Arm Awnings 折叠臂遮阳篷']],
    ['Retractable Sunroof', '伸缩天窗遮阳系统', ['Retractable Sunroof 伸缩天窗遮阳系统']],
    ['Zip-Track Blinds', '户外拉链导轨帘', ['Zip-Track 户外拉链导轨帘']],
    ['Wire Guide Blinds', '户外钢丝导轨帘', ['Wire Guide 户外钢丝导轨帘']],
    ['Vinyl Patio Blinds', '乙烯基露台帘', []],
    ['Duo/Tri Sheer Shades', '柔纱帘', ['Duo/Tri 柔纱帘']],
    ['Bamboo/Woven Blinds', '竹编/编织帘', ['竹编/编织帘']],
    ['Motorization and Smart Controls', '电动化与智能控制', []],
    [
      'MotionScreen™ Motorized Retractable Screens',
      '电动可伸缩纱窗',
      ['MotionScreen™ 电动可伸缩纱窗'],
    ],
    ['SunTex 95 Screen Fabrics', 'SunTex 95等纱网面料选项', ['SunTex 95 等纱网面料选项']],
    ['Motorized Retractable Patio Screens', '电动伸缩庭院纱窗系统', []],
    ['Solar Screen Mesh', '防晒遮阳纱窗', ['防晒遮阳纱窗（solar screen mesh）']],
    ['Insect Mesh', '防虫纱窗', ['防虫纱窗（insect mesh）']],
    ['Clear Vinyl Screens', '透明乙烯基防风雨纱窗', ['透明乙烯基防风雨纱窗（clear vinyl）']],
    ['Privacy Screens', '隐私纱窗', []],
    ['Screened Patio', '封闭式纱窗露台', ['封闭式纱窗露台（screened patio）']],
    ['Screened Porch', '纱窗门廊', ['纱窗门廊（screened porch）']],
    ['MagnaTrack Motorized Outdoor Screens', '户外电动纱窗', ['MagnaTrack 户外电动纱窗']],
    ['StruXure Pergola X', '百叶凉亭', ['StruXure Pergola X 百叶凉亭']],
    ['Corradi USA Pergotenda', '可伸缩凉棚', ['Corradi USA Pergotenda 可伸缩凉棚']],
    ['Bahama Parasols and Shade Sails', '遮阳伞与帆', ['Bahama 遮阳伞与帆（Parasols）']],
    ['StruXure Cabana X', '凉亭', ['StruXure Cabana X 凉亭']],
    ['Outdoor Accessories', '户外配件：加热、照明、音响', ['户外配件(加热、照明、音响)']],
    [
      'Motorized Retractable Exterior Screens',
      '户外电动可伸缩纱网',
      ['Exterior Screens (motorized retractable screens)'],
    ],
    ['Retractable Awnings', '可伸缩遮阳篷', ['Awnings (retractable awnings)']],
    ['Motorized Retractable Awnings', '电动可伸缩遮阳篷', ['Awnings (retractable & motorized)']],
    [
      'Blockout and Sunscreen Roller Blinds',
      '遮光及防晒卷帘',
      ['Roller blinds (blockout and sunscreen)'],
    ],
    [
      'Norman Woodlore / Woodbury / Normandy Plantation Shutters',
      '种植园式百叶窗',
      ['Plantation shutters (Norman Woodlore, Woodbury, Normandy)'],
    ],
    [
      'Crank Operated / Straight Drop Awnings',
      '手摇式/直落式遮阳篷',
      ['Crank Operated / Straight Drop 直落式遮阳篷'],
    ],
    [
      'Roller Blinds / Sunscreen Blinds',
      '室内卷帘/防晒帘',
      ['Roller Blinds 与 Sunscreen Blinds(室内卷帘/防晒帘)'],
    ],
    [
      'E ZIP / Zip Track Blinds',
      '户外防风卷帘',
      ['E ZIP / Zip Track 户外防风卷帘', 'E ZIP Blinds'],
    ],
    ['Mesh Zip Track Blinds', '网布防风卷帘', ['网布 Zip Track 卷帘']],
    ['Clear PVC Zip Track Blinds', '透明PVC防风卷帘', ['透明 PVC Zip Track 卷帘']],
    ['Ziptrak Awnings', 'Ziptrak遮阳篷', ['Ziptrak 遮阳篷']],
    ['Veri Shades', '梦幻帘', []],
    ['Zebra Blinds', '斑马帘', ['Zebra (Combi) Blinds']],
    ['Blinds', '窗帘', ['窗帘']],
    ['Curtains', '布艺帘', ['布艺帘']],
    ['Screens', '纱网', []],
    ['Security Screen Doors', '防盗纱门', ['防盗纱门']],
    ['Awnings', '遮阳篷', ['户外遮阳篷', '遮阳篷']],
    ['Outdoor Awnings', '户外遮阳篷', []],
    ['Outdoor Blinds', '户外百叶帘', ['户外百叶帘']],
    ['Roller Blinds', '卷帘', ['卷帘']],
    ['Venetian Blinds', '威尼斯百叶帘', ['威尼斯百叶帘', '百叶帘']],
    ['Shutters', '百叶窗', ['百叶窗']],
    ['Pergolas', '凉棚', ['凉棚', '凉亭']],
    ['Roman Blinds', '罗马帘', ['罗马帘']],
    ['Cellular Blinds', '蜂巢帘', ['蜂巢帘', 'Honeycomb Blinds']],
    ['Vertical Blinds', '垂直帘', ['垂直帘']],
    ['Shangri-La Sheer Shades', '香格里拉帘', ['香格里拉帘']],
    ['Outdoor Zip Screens', '户外防风帘', ['防风帘', '户外拉链帘', '双层/防风帘 / 户外拉链帘']],
  ];
  const nouns = [
    [/zip[- ]?track blinds?/gi, '防风卷帘'],
    [/zip screens?/gi, '防风帘'],
    [/folding canopy structures?/gi, '折叠天幕结构'],
    [/insect screens?/gi, '防虫纱网'],
    [/screen doors?/gi, '纱门'],
    [/movie screens?/gi, '投影幕'],
    [/screens?/gi, '纱网'],
    [/roller shades?/gi, '卷帘'],
    [/solar shades?/gi, '遮阳帘'],
    [/cellular shades?/gi, '蜂巢帘'],
    [/roman shades?/gi, '罗马帘'],
    [/sheer shades?/gi, '柔纱帘'],
    [/veri shades?/gi, '梦幻帘'],
    [/shades?/gi, '遮阳帘'],
    [/awnings?/gi, '遮阳篷'],
    [/shutters?/gi, '百叶窗'],
    [/blinds?/gi, '窗帘'],
    [/curtains?/gi, '布艺帘'],
    [/pergolas?/gi, '凉棚'],
    [/components?(?: and parts)?|parts/gi, '配件零件'],
    [/fabrics?/gi, '面料'],
    [/motors?/gi, '电机'],
    [/sample books?/gi, '样品册'],
  ];
  const modifiers = [
    [/full cassette/gi, '全盒'],
    [/folding arm/gi, '曲臂'],
    [/straight drop/gi, '垂直式'],
    [/pivot arm/gi, '支臂式'],
    [/panel(?: glide)?/gi, '板式'],
    [/plantation/gi, '种植园式'],
    [/venetian/gi, '威尼斯'],
    [/roller/gi, '卷式'],
    [/roman/gi, '罗马'],
    [/zebra(?: \(combi\))?/gi, '斑马'],
    [/cellular|honeycomb/gi, '蜂巢'],
    [/motorized|motorised|electric/gi, '电动'],
    [/automatic/gi, '自动'],
    [/retractable/gi, '可伸缩'],
    [/outdoor/gi, '户外'],
    [/indoor/gi, '室内'],
    [/blackout/gi, '遮光'],
    [/cassette/gi, '盒式'],
    [/aluminum|aluminium/gi, '铝制'],
    [/vertical/gi, '垂直'],
    [/skylight/gi, '天窗'],
    [/patio/gi, '庭院'],
    [/lanai/gi, '露台'],
    [/folding/gi, '折叠'],
    [/fabric/gi, '布艺'],
    [/bamboo/gi, '竹制'],
    [/wood/gi, '木制'],
  ];
  const rows = String(value || '')
    .split(/\r?\n/)
    .map((v) => v.trim())
    .filter(Boolean);
  const result = new Map();
  for (const row of rows) {
    const bilingual = row.match(/^(.+?)\s*[（(]([^()（）]*[\u4e00-\u9fff][^()（）]*)[)）]$/);
    const entry = catalog.find(([en, zh, aliases]) =>
      [en, zh, ...aliases].some((s) => s.toLowerCase() === row.toLowerCase()),
    );
    let english, chinese;
    if (entry) [english, chinese] = entry;
    else if (bilingual && !/[\u4e00-\u9fff]/.test(bilingual[1])) [, english, chinese] = bilingual;
    else if (/[\u4e00-\u9fff]/.test(row)) {
      const englishInParens = row.match(/[（(]([^()（）\u4e00-\u9fff]+)[)）]/);
      const prefix = row
        .slice(0, row.search(/[\u4e00-\u9fff]/))
        .replace(/[\s(（/]+$/, '')
        .trim();
      const core = catalog
        .filter(([, zh]) => row.includes(zh))
        .sort((a, b) => b[1].length - a[1].length)[0];
      if (prefix || englishInParens) {
        english = prefix || englishInParens[1];
        chinese = row
          .slice(row.search(/[\u4e00-\u9fff]/))
          .replace(/[（(][^()（）\u4e00-\u9fff]+[)）]/g, '')
          .trim();
      } else if (core) {
        english = core[0];
        chinese = row;
      } else {
        english = 'Other Products';
        chinese = row;
      }
    } else {
      english = row;
      let translated = row;
      for (const [pattern, zh] of [...nouns, ...modifiers])
        translated = translated.replace(new RegExp('\\b(?:' + pattern.source + ')\\b', 'gi'), zh);
      chinese = translated.replace(/\s+/g, '').replace(/[-/]/g, '');
      if (!/[\u4e00-\u9fff]/.test(chinese)) chinese = '其他产品';
    }
    english = english.replace(/[（(]/g, ' — ').replace(/[)）]/g, '').trim();
    chinese = chinese.replace(/[（(]/g, '：').replace(/[)）]/g, '').trim();
    result.set(
      english.toLowerCase() + (english === 'Other Products' ? ':' + chinese : ''),
      english + '(' + chinese + ')',
    );
  }
  return [...result.values()].join('\n');
}
