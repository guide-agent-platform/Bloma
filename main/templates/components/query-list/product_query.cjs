function queryRecords(snapshot,{query='',type,sort='name',descending=false,page=1,pageSize=20,selected=[]}={}){
 if(typeof query!=='string'||query.length>200||!['name','id','revision'].includes(sort)||!Number.isInteger(page)||page<1||!Number.isInteger(pageSize)||pageSize<1||pageSize>100||!Array.isArray(selected))throw Error('QUERY_INVALID')
 const all=Object.values(snapshot.records),needle=query.trim().toLocaleLowerCase()
 const matches=all.filter(row=>(!type||row.type===type)&&(!needle||JSON.stringify(row.data).toLocaleLowerCase().includes(needle)))
 const key=row=>sort==='name'?String(row.data.name??row.data.document?.name??row.id):row[sort]
 matches.sort((a,b)=>{const left=key(a),right=key(b),result=typeof left==='number'&&typeof right==='number'?left-right:String(left).localeCompare(String(right),'zh-CN');return(descending?-result:result)||a.id.localeCompare(b.id)})
 const pages=Math.max(1,Math.ceil(matches.length/pageSize)),current=Math.min(page,pages),known=new Set(matches.map(row=>row.id))
 return{revision:snapshot.revision,total:matches.length,allCount:all.length,page:current,pages,rows:matches.slice((current-1)*pageSize,current*pageSize),selected:[...new Set(selected)].filter(id=>known.has(id)),scope:'bounded_in_memory_20000_records'}
}
function createQueryController(){let generation=0;return{invalidate(){generation++},async run(load,input){const token=++generation,value=await load(input);return token===generation?{accepted:true,value}:{accepted:false,reason:'stale_response'}}}}
async function batchById(ids,operation){if(!Array.isArray(ids)||ids.length>1000||new Set(ids).size!==ids.length)throw Error('QUERY_SELECTION_INVALID');const results=[];for(const id of ids){try{results.push({id,ok:true,value:await operation(id)})}catch(error){results.push({id,ok:false,code:/^[A-Z][A-Z0-9_]+$/.test(error?.message)?error.message:'BATCH_OPERATION_FAILED'})}}return results}
module.exports={queryRecords,createQueryController,batchById}
