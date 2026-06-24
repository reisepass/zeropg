import WebSocket from 'ws'
const RELAY_URL = process.env.RELAY_URL
const EVID = process.env.EVID
const ws = new WebSocket(RELAY_URL, { handshakeTimeout: 15000 })
let got=false
const timer=setTimeout(()=>{console.error('TIMEOUT got=%s',got);process.exit(1)},20000)
ws.on('open',()=>setTimeout(()=>ws.send(JSON.stringify(['REQ','q',{ids:[EVID]}])),1500))
ws.on('message',(raw)=>{let m;try{m=JSON.parse(raw.toString())}catch{return}
  if(m[0]==='EVENT'&&m[1]==='q'&&m[2]?.id===EVID){got=true;console.log('PERSISTED: event served back from DB in a fresh connection, content=',JSON.stringify(m[2].content))}
  if(m[0]==='EOSE'&&m[1]==='q'){clearTimeout(timer);console.log(got?'PASS persisted-readback':'FAIL not found');ws.close();process.exit(got?0:1)}})
ws.on('error',e=>{console.error('err',e.message);process.exit(1)})
