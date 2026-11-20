#!/usr/bin/env python3
"""Actual owned Claude CLI, synthetic localhost model, honest external IPC peer."""
import hashlib,json,os,selectors,shutil,signal,socket,sqlite3,stat,struct,subprocess,tempfile,threading,time,uuid
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from acceptance_backend import Backend
from bridge import Binding, Spool, route_local
from linux_peer import process_start, socket_peer
from wire import PeerIdentity
os.umask(0o077)
if not hasattr(socket,'SO_PEERCRED'):
 raise SystemExit('Unsupported platform: this experimental live probe requires Linux SO_PEERCRED')
claude=os.environ.get('XATS_NATIVE_CLAUDE') or shutil.which('claude')
if not claude:raise SystemExit('Pinned Claude executable not found; set XATS_NATIVE_CLAUDE')
base=Path(os.environ.get('XATS_NATIVE_RESULTS',str(Path(tempfile.gettempdir())/'xats-native-probe')));base.mkdir(parents=True,exist_ok=True)
root=Path(tempfile.mkdtemp(prefix='o-',dir=base))
for n in ['h','w','r','t','c']:(root/n).mkdir(mode=0o700)
socks=root/'r'/'cc-socks';socks.mkdir(mode=0o700)
external=socks/f'{os.getpid()}.sock';native=socks/'claude.sock'
text='xats-native-outbound-owned-fixture'
report={'synthetic_model':True,'real_model_inference':False,'external_registry_records_written':0,'private_key_files_read_by_probe':0,'requests':0,'tool_names':[],'tool_schema':None,'tool_input':None,'received':[],'child_events':[]}
request_count=0
delivery_event=threading.Event()
class Model(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_HEAD(self):self.send_response(200);self.end_headers()
 def do_POST(self):
  global request_count
  size=int(self.headers.get('Content-Length','0'))
  if size>1048576:self.send_error(413);return
  try:body=json.loads(self.rfile.read(size))
  except ValueError:self.send_error(400);return
  if 'count_tokens' in self.path:
   data=b'{"input_tokens":1}';self.send_response(200);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data);return
  if not self.path.split('?')[0].rstrip('/').endswith('/messages'):self.send_error(404);return
  request_count+=1;report['requests']=request_count
  tools=body.get('tools',[]);report['tool_names']=[t.get('name') for t in tools]
  tool=next((t for t in tools if t.get('name')=='SendMessage'),None)
  block={'type':'text','text':'Owned native fixture complete.'};stop='end_turn'
  if tool and request_count==1:
   schema=tool.get('input_schema',{})
   props=schema.get('properties',{});params={}
   report['tool_schema']={'fields':sorted(props),'required':schema.get('required',[])}
   for name in props:
    if name in ['to','recipient']:params[name]='uds:'+str(external)
    elif name in ['message','content']:params[name]=text
    elif name=='type':params[name]='message'
    elif name=='summary':params[name]='Owned native protocol fixture'
   missing=set(schema.get('required',[]))-set(params)
   if not missing and any(k in params for k in ['to','recipient']) and any(k in params for k in ['message','content']):
    report['tool_input']=params;block={'type':'tool_use','id':'toolu_xats_owned_fixture','name':'SendMessage','input':params};stop='tool_use'
   else:report['schema_blocker']='Required schema not understood: '+','.join(sorted(missing))
  if request_count>1 and report.get('tool_input'):
   report['model_stub_waited_for_delivery']=delivery_event.wait(6)
  message={'id':'msg_xats_owned_fixture','type':'message','role':'assistant','model':body.get('model','fixture'),'content':[],'stop_reason':None,'stop_sequence':None,'usage':{'input_tokens':1,'output_tokens':0}}
  if body.get('stream'):
   events=[('message_start',{'type':'message_start','message':message})]
   if block['type']=='tool_use':
    events.extend([('content_block_start',{'type':'content_block_start','index':0,'content_block':{**block,'input':{}}}),('content_block_delta',{'type':'content_block_delta','index':0,'delta':{'type':'input_json_delta','partial_json':json.dumps(block['input'])}})])
   else:events.extend([('content_block_start',{'type':'content_block_start','index':0,'content_block':{'type':'text','text':''}}),('content_block_delta',{'type':'content_block_delta','index':0,'delta':{'type':'text_delta','text':block['text']}})])
   events.extend([('content_block_stop',{'type':'content_block_stop','index':0}),('message_delta',{'type':'message_delta','delta':{'stop_reason':stop,'stop_sequence':None},'usage':{'output_tokens':1}}),('message_stop',{'type':'message_stop'})])
   data=''.join('event: '+name+'\ndata: '+json.dumps(obj)+'\n\n' for name,obj in events).encode();self.send_response(200);self.send_header('Content-Type','text/event-stream');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
  else:
   message.update(content=[block],stop_reason=stop,usage={'input_tokens':1,'output_tokens':1});data=json.dumps(message).encode();self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
server=ThreadingHTTPServer(('127.0.0.1',0),Model);threading.Thread(target=server.serve_forever,daemon=True).start()
listener=socket.socket(socket.AF_UNIX);listener.bind(str(external));os.chmod(external,0o600);listener.listen(4);listener.setblocking(False)
spool=Spool(root/'spool.db');backend=None;binding=None;last_key=None
env={'PATH':os.environ.get('PATH','/usr/local/bin:/usr/bin:/bin'),'HOME':str(root/'h'),'USERPROFILE':str(root/'h'),'CLAUDE_CONFIG_DIR':str(root/'c'),'TMPDIR':str(root/'t'),'XDG_RUNTIME_DIR':str(root/'r'),'LANG':'C.UTF-8','ANTHROPIC_BASE_URL':f'http://127.0.0.1:{server.server_port}','ANTHROPIC_API_KEY':'xats-local-fixture-not-a-real-key','DISABLE_TELEMETRY':'1','DISABLE_ERROR_REPORTING':'1'}
cmd=[claude,'--safe-mode','--setting-sources','','--settings','{"crossSessionInbound":"refuse"}','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--tools','SendMessage','--no-session-persistence','--permission-mode','manual','--permission-prompts','none','--messaging-socket-path',str(native),'--model','sonnet','--max-turns','3','--print','--verbose','--output-format','stream-json','Execute the single owned SendMessage fixture supplied by the local test model, then stop. Destination is the explicitly owned external xats test socket.']
p=None;sel=selectors.DefaultSelector();out=base/f'outbound-{uuid.uuid4().hex[:8]}.json'
try:
 version=subprocess.run([claude,'--version'],env=env,cwd=root/'w',capture_output=True,text=True,timeout=5,check=True).stdout.strip();assert version.startswith('2.1.295 ');report['version']=version
 daemon_entry=os.environ.get('XATS_NATIVE_DAEMON_ENTRY')
 if daemon_entry:
  backend=Backend(root,daemon_entry,env);backend.start()
  sender_id=backend.register('native-source');target_id=backend.register('native-target')
  report['owned_xats_backend']=True
 p=subprocess.Popen(cmd,cwd=root/'w',env=env,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True);report['child_pid']=p.pid
 expected_peer=PeerIdentity(p.pid,os.getuid(),process_start(p.pid))
 binding=Binding(expected_peer,str(native),sender_id if backend else 'quarantined-source','native-fixture','native-source',target_id if backend else 'quarantined-target')
 sel.register(p.stdout,selectors.EVENT_READ,'stdout');sel.register(p.stderr,selectors.EVENT_READ,'stderr');sel.register(listener,selectors.EVENT_READ,'peer');buffers={'stdout':b'','stderr':b''};deadline=time.monotonic()+22
 while time.monotonic()<deadline and (p.poll() is None or sel.get_map()):
  if p.poll() is not None and len(sel.get_map())==1:break
  for key,_ in sel.select(0.05):
   if key.data=='peer':
    c,_=listener.accept();c.settimeout(1);observed=socket_peer(c);cred=(observed.pid,observed.uid);data=b''
    while len(data)<65536:
     b=c.recv(4096)
     if not b:break
     data+=b
    c.close()
    for line in data.splitlines():
     try:frame=json.loads(line)
     except ValueError:continue
     if frame.get('type')!='user':report['received'].append({'type':frame.get('type'),'non_user_frame':True});continue
     body=frame.get('message',{}).get('content');mid=frame.get('msg_id');verified=observed==expected_peer
     report['received'].append({'type':frame.get('type'),'keys':sorted(frame),'msgV':frame.get('msgV'),'valid_id':isinstance(mid,str) and len(mid)==36,'peer_pid_matches_child':cred[0]==p.pid,'peer_uid_matches_owner':cred[1]==os.getuid(),'fixture_in_body':isinstance(body,str) and text in body,'body_excerpt':body[:350] if isinstance(body,str) else None,'from_matches_child_socket':frame.get('from')=='uds:'+str(native)})
     if not verified or not isinstance(body,str) or text not in body:continue
     last_key=spool.accept(frame,binding,observed)
     fact=spool.forward_once(last_key,binding,lambda bound,value:route_local(backend.base,bound,value)) if backend else spool.fact(last_key)
     report['forwarding_fact']=fact
     # Only a verified xats commit can produce delivered (mailbox admission,
     # never model reading); quarantined/uncertain outcomes remain held.
     if frame.get('from')=='uds:'+str(native):
      st=native.lstat();assert stat.S_ISSOCK(st.st_mode) and st.st_uid==os.getuid()
      with socket.socket(socket.AF_UNIX) as reply:
       reply.settimeout(1);reply.connect(str(native));rc=struct.unpack('3i',reply.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12));assert rc[0]==p.pid and rc[1]==os.getuid()
       reply.sendall((json.dumps({'msgV':1,'msg_id':str(uuid.uuid4()),'type':'control','action':'peer_message_status','orig_msg_id':mid,'status':fact['native_receipt'],'from':'uds:'+str(external)})+'\n').encode());reply.shutdown(socket.SHUT_WR);report['native_receipt_sent']=fact['native_receipt'];delivery_event.set()
   else:
    name=key.data;data=os.read(key.fileobj.fileno(),65536)
    if not data:sel.unregister(key.fileobj);continue
    buffers[name]=(buffers[name]+data)[-131072:]
    while b'\n' in buffers[name]:
     line,buffers[name]=buffers[name].split(b'\n',1)
     if name=='stdout':
      try:event=json.loads(line)
      except ValueError:continue
      info={'type':event.get('type')}
      if event.get('type')=='result':info.update(subtype=event.get('subtype'),is_error=event.get('is_error'))
      for b in event.get('message',{}).get('content',[]) if isinstance(event.get('message'),dict) else []:
       if isinstance(b,dict) and b.get('type')=='tool_result':info['tool_result']=str(b.get('content'))[:1600]
      report['child_events'].append(info)
     elif any(k in line.lower() for k in [b'error',b'not logged in',b'unknown option']):report.setdefault('stderr_categories',[]).append('startup/runtime diagnostic')
 report['spool_rows']=spool.db.execute('SELECT COUNT(*) FROM incoming').fetchone()[0]
 if backend and last_key:
  before=backend.inbox('native-target')['messages'];report['xats_mailbox_before_restart']=len(before)
  assert len(before)==1 and text in before[0]['body'] and before[0]['from_agent_id']==sender_id and before[0]['to_agent_id']==target_id
  def no_duplicate(*unused):raise AssertionError('duplicate external dispatch')
  assert spool.forward_once(last_key,binding,no_duplicate)['state']=='forwarded'
  backend.stop();backend.start()
  after=backend.inbox('native-target')['messages'];report['xats_mailbox_after_restart']=len(after)
  rows=backend.request('/api/agents?team=native-fixture')['agents']
  report['registrations_preserved']=set([sender_id,target_id]).issubset({row['agent_id'] for row in rows})
  assert len(after)==1 and after[0]['id']==before[0]['id'] and report['registrations_preserved']
  report['xats_restart_and_duplicate_checks']=True
finally:
 if p and p.poll() is None:
  os.killpg(p.pid,signal.SIGTERM)
  try:p.wait(timeout=3)
  except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait()
 if p:
  report['exit']=p.returncode;p.stdout.close();p.stderr.close()
 sel.close();listener.close();spool.close();delivery_event.set()
 if backend:backend.stop()
 server.shutdown();server.server_close();shutil.rmtree(root)
 out.write_text(json.dumps(report,indent=2)+'\n');print(out);print(json.dumps(report,indent=2))
valid=report.get('spool_rows')==1 and report.get('native_receipt_sent') in ['held','delivered']
if report.get('owned_xats_backend'):valid=valid and report.get('xats_restart_and_duplicate_checks') and report.get('native_receipt_sent')=='delivered'
raise SystemExit(0 if valid else 2)
