import {RemoteGateway, type RemoteOptions} from './RemoteGateway.js';
import {badState} from '../office/errors.js';

/** Remote failures must never shut down local Office. Retry is serialized. */
export class OptionalRemote {
  private gateway?: RemoteGateway;
  private error?: string;
  private starting?: Promise<number | undefined>;
  constructor(private options:RemoteOptions, private factory=(o:RemoteOptions)=>new RemoteGateway(o)) {}
  start():Promise<number|undefined> {
    if(this.gateway)return Promise.resolve(this.gateway.port);
    return this.starting ??= this.open().finally(()=>{this.starting=undefined;});
  }
  private async open():Promise<number|undefined> {
    let candidate:RemoteGateway|undefined;
    try {
      candidate=this.factory(this.options);
      const port=await candidate.listen();
      this.gateway=candidate;this.error=undefined;return port;
    } catch(err) {
      await candidate?.close().catch(()=>{});
      this.error='원격 연결을 시작하지 못했습니다. 포트 충돌과 데이터 폴더 쓰기 권한을 확인하고 다시 시도하세요. '+String(err);
      console.warn('[remote] '+this.error);
      return undefined;
    }
  }
  localHandlers():Record<string,(p:Record<string,unknown>)=>unknown> {
    const handlers:Record<string,(p:Record<string,unknown>)=>unknown>={
      'remote.status':()=>this.status(),
      'remote.retry':async()=>{await this.start();return this.status();},
    };
    for(const name of ['remote.configure','remote.pair.create','remote.device.approve','remote.device.revoke']) {
      handlers[name]=p=>{
        if(!this.gateway)throw badState(this.error ?? '원격 연결을 시작하는 중입니다.');
        const methods=this.gateway.localHandlers() as Record<string,(p:Record<string,unknown>)=>unknown>;
        return methods[name](p);
      };
    }
    return handlers;
  }
  status(){return this.gateway ? {available:true,...this.gateway.localHandlers()['remote.status']()} : {available:false,message:this.error,devices:[]};}
  async close(){await this.starting;await this.gateway?.close();this.gateway=undefined;}
}
