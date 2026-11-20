#!/usr/bin/env python3
"""Bounded owned-session native IPC probe. No real credentials or model calls."""
import argparse, json, os, selectors, shutil, signal, socket, stat, struct, subprocess, tempfile, time, uuid
from pathlib import Path
from linux_peer import process_start, socket_peer
from wire import PeerIdentity, decode_receipt, encode_peer_message

ap=argparse.ArgumentParser(); ap.add_argument('--policy',choices=['refuse','hold'],required=True); args=ap.parse_args()
os.umask(0o077)
if not hasattr(socket, 'SO_PEERCRED'):
 raise SystemExit('Unsupported platform: this experimental live probe requires Linux SO_PEERCRED')
claude=os.environ.get('XATS_NATIVE_CLAUDE') or shutil.which('claude')
if not claude:raise SystemExit('Pinned Claude executable not found; set XATS_NATIVE_CLAUDE')
base=Path(os.environ.get('XATS_NATIVE_RESULTS',str(Path(tempfile.gettempdir())/'xats-native-probe'))); base.mkdir(parents=True,exist_ok=True)
root=Path(tempfile.mkdtemp(prefix='p-',dir=base)); dirs={n:root/n for n in ['h','w','t','r','c']}
for d in dirs.values():d.mkdir(mode=0o700)
socks=dirs['r']/'cc-socks'; socks.mkdir(mode=0o700)
inbox=socks/'receiver.sock'; reply=socks/f'{os.getpid()}.sock'
report={'version':'2.1.295','policy':args.policy,'identity':'external xats-experiment process, not a Claude session','external_registry_records_written':0,'private_key_files_read_by_probe':0,'receipts':[],'uds_writes':0,'model_requests':0,'http_requests':[]}
listener=socket.socket(socket.AF_UNIX); listener.bind(str(reply)); os.chmod(reply,0o600);listener.listen(4);listener.setblocking(False)
# Any accidental model request has no usable credentials or remote model URL.
sink=socket.socket(); sink.bind(('127.0.0.1',0));sink.listen(4);sink.setblocking(False)
env={'PATH':os.environ.get('PATH','/usr/local/bin:/usr/bin:/bin'),'HOME':str(dirs['h']),'USERPROFILE':str(dirs['h']),'TMPDIR':str(dirs['t']),'XDG_RUNTIME_DIR':str(dirs['r']),'CLAUDE_CONFIG_DIR':str(dirs['c']),'LANG':'C.UTF-8','ANTHROPIC_BASE_URL':f'http://127.0.0.1:{sink.getsockname()[1]}','DISABLE_TELEMETRY':'1','DISABLE_ERROR_REPORTING':'1'}
cmd=[claude,'--safe-mode','--setting-sources','','--settings',json.dumps({'crossSessionInbound':args.policy}),'--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--tools','','--no-session-persistence','--permission-mode','manual','--permission-prompts','none','--messaging-socket-path',str(inbox),'--debug-file',str(root/'debug.log'),'--print','--verbose','--input-format','stream-json','--output-format','stream-json']
p=None; sel=selectors.DefaultSelector(); report_path=base/f'policy-{args.policy}-{uuid.uuid4().hex[:8]}.json'
try:
 version=subprocess.run([claude,'--version'],env=env,cwd=dirs['w'],capture_output=True,text=True,timeout=5,check=True).stdout.strip()
 assert version.startswith('2.1.295 '), 'Unsupported Claude version'
 report['observed_version']=version
 p=subprocess.Popen(cmd,cwd=dirs['w'],env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
 report['child_pid']=p.pid
 expected_peer=PeerIdentity(p.pid,os.getuid(),process_start(p.pid))
 p.stdin.write((json.dumps({'type':'control_request','request_id':'xats-experiment-init','request':{'subtype':'initialize'}})+'\n').encode());p.stdin.flush()
 for name,stream in [('stdout',p.stdout),('stderr',p.stderr)]:sel.register(stream,selectors.EVENT_READ,name)
 sel.register(listener,selectors.EVENT_READ,'receipt');sel.register(sink,selectors.EVENT_READ,'model')
 buffers={'stdout':b'','stderr':b''}; initialized=False; sent=False;deadline=time.monotonic()+10
 msg_id=str(uuid.uuid4());report['message_id']=msg_id
 while time.monotonic()<deadline and p.poll() is None:
  if not sent and initialized and inbox.exists():
   st=inbox.lstat();assert stat.S_ISSOCK(st.st_mode) and st.st_uid==os.getuid() and stat.S_IMODE(st.st_mode)==0o600
   _, encoded=encode_peer_message('Owned xats protocol compatibility probe. No task or model response requested.',str(reply),sender_pid=os.getpid(),message_id=msg_id)
   with socket.socket(socket.AF_UNIX) as s:
    s.settimeout(2);s.connect(str(inbox));cred=struct.unpack('3i',s.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12));assert cred[0]==p.pid and cred[1]==os.getuid();s.sendall(encoded);s.shutdown(socket.SHUT_WR)
   report['uds_writes']+=1;sent=True;deadline=min(deadline,time.monotonic()+3)
  for key,_ in sel.select(0.05):
   name=key.data
   if name=='model':
    c,_=sink.accept();c.settimeout(1)
    try:first=c.recv(2048).split(b'\r\n',1)[0].decode('ascii','replace').split(' ')
    except TimeoutError:first=[]
    method=first[0] if first else 'unknown';path=first[1].split('?',1)[0] if len(first)>1 else 'unknown'
    report['http_requests'].append({'method':method,'path':path})
    if path.rstrip('/').endswith('/messages'):report['model_requests']+=1
    c.sendall(b'HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');c.close()
   elif name=='receipt':
    c,_=listener.accept();c.settimeout(1);observed=socket_peer(c);cred=(observed.pid,observed.uid);data=b''
    while len(data)<65536:
     b=c.recv(4096)
     if not b:break
     data+=b
    c.close()
    for line in data.splitlines():
     try:r=json.loads(line)
     except ValueError:continue
     try:fact=decode_receipt(r,message_id=msg_id,expected_peer=expected_peer,observed_peer=observed)
     except ValueError:
      report.setdefault('rejected_receipts',0);report['rejected_receipts']+=1;continue
     report['receipts'].append({**fact,'peer_pid_matches_child':cred[0]==p.pid,'peer_uid_matches_owner':cred[1]==os.getuid(),'process_start_matches':observed.start_token==expected_peer.start_token,'type':r.get('type'),'action':r.get('action'),'correlated':True})
   else:
    data=os.read(key.fileobj.fileno(),65536)
    if not data:sel.unregister(key.fileobj);continue
    buffers[name]=(buffers[name]+data)[-131072:]
    while b'\n' in buffers[name]:
     line,buffers[name]=buffers[name].split(b'\n',1)
     if name=='stdout':
      try:o=json.loads(line)
      except ValueError:continue
      if o.get('type')=='control_response':initialized=o.get('response',{}).get('subtype')=='success';report['initialized']=initialized
     elif any(marker in line.lower() for marker in [b'unknown option',b'invalid setting',b'not logged in']):report.setdefault('diagnostics',[]).append('startup/auth diagnostic')
 report['socket_observed']=inbox.exists();report['natural_exit']=p.poll()
finally:
 if p and p.poll() is None:
  os.killpg(p.pid,signal.SIGTERM)
  try:p.wait(timeout=3)
  except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait()
 if p:
  report['final_exit']=p.returncode
  for stream in [p.stdin,p.stdout,p.stderr]:stream.close()
 sel.close();listener.close();sink.close()
 debug=root/'debug.log'
 if debug.exists():
  report['policy_debug']=[line.strip()[:500] for line in debug.read_text(errors='replace').splitlines() if any(marker in line for marker in ['[cross-session-inbound]','[uds-messaging] Routed','setting source','crossSessionInbound'])][-12:]
 shutil.rmtree(root)
 report_path.write_text(json.dumps(report,indent=2)+'\n');print(report_path);print(json.dumps(report,indent=2))
valid=any(r['correlated'] and r['peer_pid_matches_child'] and r['peer_uid_matches_owner'] and r['status']==args.policy.replace('refuse','refused').replace('hold','held') for r in report['receipts'])
raise SystemExit(0 if valid and report['model_requests']==0 else 2)
