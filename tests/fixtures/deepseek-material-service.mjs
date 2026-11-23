// Offline responses for the synthetic files used by material and mail browser regressions.
export async function materialService(url, init) {
  if (url === 'https://api.deepseek.com/v1/tools/ocr') {
    const file = init.body.get('file');
    const purpose = init.body.get('purpose');
    if (file.name.endsWith('.pdf') && file.size < 100) return Response.json({error:{code:'invalid_pdf'}},{status:400});
    const lines = file.name.endsWith('.docx')
      ? ['测试规格', '叶片 89 mm']
      : ['Catalog introduction: printed reference R-80.', 'Mixed catalog / MX42 track specifications\nMX42 track width is 73 mm.\n行程 125 毫米', 'Order code ZX905\nFinish: Silver'];
    return Response.json({purpose,page_count:lines.length,pages:lines.map((text,index)=>({index,text,finish_reason:'stop'}))});
  }
  if (url === 'https://api.deepseek.com/files') return Response.json({id:'file-api-synthetic'});
  if (url === 'https://api.deepseek.com/files/file-api-synthetic' && init.method === 'DELETE') return Response.json({deleted:true});
  if (url === 'https://api.deepseek.com/chat/completions') {
    const {messages}=JSON.parse(init.body);
    if (Array.isArray(messages?.[1]?.content)) return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({facts:[],uncertain:false})}}]});
  }
  throw Error('Unexpected material service request');
}
