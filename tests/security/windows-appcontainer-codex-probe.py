"""Disposable AppContainer launch probe; never production wrapper."""
import ctypes as C
from ctypes import wintypes as W
import os, pathlib, uuid, subprocess, shutil, sys, msvcrt
K=C.WinDLL('kernel32',use_last_error=True)
U=C.WinDLL('userenv',use_last_error=True)
A=C.WinDLL('advapi32',use_last_error=True)
LP=C.c_void_p
class SECURITY_CAPABILITIES(C.Structure):
    _fields_=[('AppContainerSid',LP),('Capabilities',LP),('CapabilityCount',W.DWORD),('Reserved',W.DWORD)]
class STARTUPINFO(C.Structure):
    _fields_=[('cb',W.DWORD),('lpReserved',W.LPWSTR),('lpDesktop',W.LPWSTR),('lpTitle',W.LPWSTR),('dwX',W.DWORD),('dwY',W.DWORD),('dwXSize',W.DWORD),('dwYSize',W.DWORD),('dwXCountChars',W.DWORD),('dwYCountChars',W.DWORD),('dwFillAttribute',W.DWORD),('dwFlags',W.DWORD),('wShowWindow',W.WORD),('cbReserved2',W.WORD),('lpReserved2',LP),('hStdInput',W.HANDLE),('hStdOutput',W.HANDLE),('hStdError',W.HANDLE)]
class STARTUPINFOEX(C.Structure):
    _fields_=[('StartupInfo',STARTUPINFO),('lpAttributeList',LP)]
class PROCESS_INFORMATION(C.Structure):
    _fields_=[('hProcess',W.HANDLE),('hThread',W.HANDLE),('dwProcessId',W.DWORD),('dwThreadId',W.DWORD)]
U.CreateAppContainerProfile.argtypes=[W.LPCWSTR,W.LPCWSTR,W.LPCWSTR,LP,W.DWORD,C.POINTER(LP)]
U.CreateAppContainerProfile.restype=W.LONG
U.DeleteAppContainerProfile.argtypes=[W.LPCWSTR];U.DeleteAppContainerProfile.restype=W.LONG
K.LocalFree.argtypes=[LP];K.LocalFree.restype=LP
A.ConvertSidToStringSidW.argtypes=[LP,C.POINTER(W.LPWSTR)];A.ConvertSidToStringSidW.restype=W.BOOL
A.FreeSid.argtypes=[LP];A.FreeSid.restype=LP
K.InitializeProcThreadAttributeList.argtypes=[LP,W.DWORD,W.DWORD,C.POINTER(C.c_size_t)];K.InitializeProcThreadAttributeList.restype=W.BOOL
K.UpdateProcThreadAttribute.argtypes=[LP,W.DWORD,C.c_size_t,LP,C.c_size_t,LP,LP];K.UpdateProcThreadAttribute.restype=W.BOOL
K.DeleteProcThreadAttributeList.argtypes=[LP]
K.CreateProcessW.argtypes=[W.LPCWSTR,W.LPWSTR,LP,LP,W.BOOL,W.DWORD,LP,W.LPCWSTR,C.POINTER(STARTUPINFOEX),C.POINTER(PROCESS_INFORMATION)];K.CreateProcessW.restype=W.BOOL
K.WaitForSingleObject.argtypes=[W.HANDLE,W.DWORD];K.WaitForSingleObject.restype=W.DWORD
K.GetExitCodeProcess.argtypes=[W.HANDLE,C.POINTER(W.DWORD)];K.GetExitCodeProcess.restype=W.BOOL
K.CloseHandle.argtypes=[W.HANDLE]
K.TerminateProcess.argtypes=[W.HANDLE,W.UINT];K.TerminateProcess.restype=W.BOOL
def fail(name): raise OSError(C.get_last_error(),name)
def run():
 root=pathlib.Path(os.environ['LOCALAPPDATA'])/'hermes/cache/scratch'/('appcontainer-'+uuid.uuid4().hex)
 root.mkdir()
 profile='MycelinkProbe'+uuid.uuid4().hex
 sid=LP(); created=False
 try:
  hr=U.CreateAppContainerProfile(profile,'probe','temporary probe',None,0,C.byref(sid))
  print('CreateAppContainerProfile HRESULT',hex(hr&0xffffffff),'SID',bool(sid),flush=True)
  if hr:raise OSError(hr&0xffffffff,'CreateAppContainerProfile')
  created=True
  sid_string=W.LPWSTR()
  if not A.ConvertSidToStringSidW(sid,C.byref(sid_string)): fail('ConvertSidToStringSidW')
  print('SID',sid_string.value,flush=True)
  try:
   acl=subprocess.run(['icacls',str(root),'/grant','*'+sid_string.value+':(OI)(CI)M'],capture_output=True)
   print('scratch_ACL_exit',acl.returncode,flush=True)
   if acl.returncode:raise RuntimeError('scratch ACL grant failed')
  finally: K.LocalFree(sid_string)
  size=C.c_size_t()
  K.InitializeProcThreadAttributeList(None,2,0,C.byref(size))
  attrs=C.create_string_buffer(size.value)
  if not K.InitializeProcThreadAttributeList(attrs,2,0,C.byref(size)):fail('InitializeProcThreadAttributeList')
  try:
   caps=SECURITY_CAPABILITIES(sid,None,0,0)
   if not K.UpdateProcThreadAttribute(attrs,0,0x20009,C.byref(caps),C.sizeof(caps),None,None):fail('UpdateProcThreadAttribute')
   si=STARTUPINFOEX();si.StartupInfo.cb=C.sizeof(si);si.lpAttributeList=C.cast(attrs,LP)
   log_fd=os.open(root/'captured.txt',os.O_CREAT|os.O_WRONLY|os.O_TRUNC,0o600)
   null_fd=os.open(os.devnull,os.O_RDONLY)
   for fd in (log_fd,null_fd):os.set_handle_inheritable(msvcrt.get_osfhandle(fd),True)
   handles=(W.HANDLE*2)(msvcrt.get_osfhandle(log_fd),msvcrt.get_osfhandle(null_fd))
   if not K.UpdateProcThreadAttribute(attrs,0,0x20002,C.cast(handles,LP),C.sizeof(handles),None,None):fail('UpdateProcThreadAttribute HANDLE_LIST')
   si.StartupInfo.dwFlags=0x100
   si.StartupInfo.hStdInput=handles[1];si.StartupInfo.hStdOutput=handles[0];si.StartupInfo.hStdError=handles[0]
   info=PROCESS_INFORMATION()
   exe=pathlib.Path(os.environ.get('PROBE_EXE') or str(pathlib.Path(os.environ['APPDATA'])/'npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe'))
   copied=root/'codex.exe';shutil.copy2(exe,copied);exe=copied
   env={key:os.environ[key] for key in ('SystemRoot','WINDIR','COMSPEC','PATH','PATHEXT') if key in os.environ}
   env.update(USERPROFILE=str(root),HOMEDRIVE=str(root.drive),HOMEPATH=str(root)[2:],APPDATA=str(root),LOCALAPPDATA=str(root),CODEX_HOME=str(root),TMP=str(root),TEMP=str(root))
   block=C.create_unicode_buffer('\0'.join(f'{k}={v}' for k,v in sorted(env.items(),key=lambda x:x[0].lower()))+'\0\0')
   cmd=C.create_unicode_buffer('"'+str(exe)+'" '+os.environ.get('PROBE_ARGS','--version'))
   ok=K.CreateProcessW(str(exe),cmd,None,None,True,0x00080000|0x00000400|0x08000000,C.cast(block,LP),str(root),C.byref(si),C.byref(info))
   error=C.get_last_error()
   print('CreateProcessW',bool(ok),'GetLastError',error,'exe_exists',exe.exists(),flush=True)
   result=None
   if ok:
    try:
     wait=K.WaitForSingleObject(info.hProcess,15000)
     if wait==0x102:
      print('timeout: terminating exact probe process',info.dwProcessId,flush=True)
      K.TerminateProcess(info.hProcess,1);K.WaitForSingleObject(info.hProcess,5000)
     exitcode=W.DWORD();K.GetExitCodeProcess(info.hProcess,C.byref(exitcode));result=exitcode.value;print('wait',hex(wait),'exit',hex(exitcode.value),flush=True)
    finally:
     K.CloseHandle(info.hThread);K.CloseHandle(info.hProcess)
   os.close(log_fd);os.close(null_fd)
   captured=(root/'captured.txt').read_text(errors='replace')
   print('captured',repr(captured[:1000]),flush=True)
   if not ok:raise OSError(error,'CreateProcessW')
   if result != 0:raise RuntimeError(f'whole executable failed: NTSTATUS/exit 0x{result:08x}')
   if not os.environ.get('PROBE_EXE') and 'codex-cli' not in captured:
    raise RuntimeError('Codex version not captured')
  finally:K.DeleteProcThreadAttributeList(attrs)
 finally:
  if sid:A.FreeSid(sid)
  if created:print('DeleteAppContainerProfile HRESULT',hex(U.DeleteAppContainerProfile(profile)&0xffffffff),flush=True)
  shutil.rmtree(root)
  print('scratch_cleaned',not root.exists(),flush=True)
if __name__=='__main__':run()
