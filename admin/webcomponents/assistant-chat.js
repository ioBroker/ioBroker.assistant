import{createRoot as e,useLayoutEffect as t,useRef as n,useState as r,Fragment as i,jsx as a,jsxs as o}from"../../../lib/esm/react-19.js";var s=`iob-dialog-close`;function c(e){return!!e.form}var l=[`header`,`staticText`,`divider`];function u(e,t){return e==null?``:typeof e==`object`?e[t]||e.en||Object.values(e).find(e=>!!e)||``:String(e)}function d(e){let t={};for(let[n,r]of Object.entries(e.items||{}))r&&!l.includes(r.type)&&(t[n]=r.type);return t}function f(e){return typeof e==`string`?e:typeof e==`number`||typeof e==`boolean`?e.toString():JSON.stringify(e)}function p(e,t){if(t!=null)switch(e){case`number`:case`slider`:{if(typeof t==`number`)return Number.isFinite(t)?t:void 0;let e=f(t).trim().replace(`,`,`.`);if(!e)return;let n=Number(e);return Number.isFinite(n)?n:void 0}case`checkbox`:return t===!0||t===`true`||t===1||t===`1`;default:return f(t)}}function m(e,t){let n={};for(let[r,i]of Object.entries(e)){let e=p(i,t[r]);e!==void 0&&(n[r]=e)}return n}var h=`"Roboto", "Helvetica", "Arial", sans-serif`,g=Object.freeze({type:`light`,primary:`#3399CC`,primaryContrast:`#FFFFFF`,secondary:`#164477`,secondaryContrast:`#FFFFFF`,background:`#FFFFFF`,paper:`#FFFFFF`,text:`rgba(0, 0, 0, 0.87)`,textSecondary:`rgba(0, 0, 0, 0.6)`,divider:`rgba(0, 0, 0, 0.12)`,error:`#D32F2F`,warning:`#ED6C02`,info:`#0288D1`,success:`#2E7D32`,fontFamily:h,fontSize:14,borderRadius:4}),_=Object.freeze({type:`dark`,primary:`#4DABF5`,primaryContrast:`rgba(0, 0, 0, 0.87)`,secondary:`#436A93`,secondaryContrast:`#FFFFFF`,background:`#121212`,paper:`#121212`,text:`#FFFFFF`,textSecondary:`rgba(255, 255, 255, 0.7)`,divider:`rgba(255, 255, 255, 0.12)`,error:`#F44336`,warning:`#FFA726`,info:`#29B6F6`,success:`#66BB6A`,fontFamily:h,fontSize:14,borderRadius:4}),v=[`primary`,`primaryContrast`,`secondary`,`secondaryContrast`,`background`,`paper`,`text`,`textSecondary`,`divider`,`error`,`warning`,`info`,`success`,`fontFamily`],y=[`fontSize`,`borderRadius`];function b(e){return{...e===`dark`?_:g}}function x(e){if(!e||typeof e!=`object`)return b(typeof e==`string`?e:`light`);let t=e,n=b(typeof t.type==`string`?t.type:`light`);for(let e of v){let r=t[e];typeof r==`string`&&r.trim()&&(n[e]=r.trim())}for(let e of y){let r=t[e],i=typeof r==`string`?parseFloat(r):r;typeof i==`number`&&Number.isFinite(i)&&i>=0&&(n[e]=i)}return n}function S(e,t){return e.type===t.type&&v.every(n=>e[n]===t[n])&&y.every(n=>e[n]===t[n])}function C(e){return`--iob-${e.replace(/[A-Z]/g,e=>`-${e.toLowerCase()}`)}`}function w(e){let t={};for(let n of v)t[C(n)]=e[n];for(let n of y)t[C(n)]=`${e[n]}px`;return t[`color-scheme`]=e.type,t}var T={ok:{en:`OK`,"zh-cn":`确定`},cancel:{en:`Cancel`,de:`Abbrechen`,ru:`Отмена`,pt:`Cancelar`,nl:`Annuleren`,fr:`Annuler`,it:`Annulla`,es:`Cancelar`,pl:`Anuluj`,uk:`Скасувати`,"zh-cn":`取消`},close:{en:`Close`,de:`Schließen`,ru:`Закрыть`,pt:`Fechar`,nl:`Sluiten`,fr:`Fermer`,it:`Chiudi`,es:`Cerrar`,pl:`Zamknij`,uk:`Закрити`,"zh-cn":`关闭`}},E=`
dialog {
    box-sizing: border-box;
    width: 480px;
    max-width: calc(100vw - 32px);
    max-height: calc(100vh - 32px);
    padding: 0;
    border: 0;
    border-radius: calc(var(--iob-border-radius) * 2);
    background: var(--iob-paper);
    color: var(--iob-text);
    font-family: var(--iob-font-family);
    font-size: var(--iob-font-size);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
}
/* as the dialogs of MUI: a dark paper gets lighter the higher it lies */
dialog.dark { background-image: linear-gradient(rgba(255, 255, 255, 0.16), rgba(255, 255, 255, 0.16)); }
dialog::backdrop { background: rgba(0, 0, 0, 0.5); }
dialog:focus { outline: none; }
form { display: flex; flex-direction: column; height: 100%; max-height: inherit; margin: 0; }
header { display: flex; align-items: center; gap: 8px; padding: 12px 8px 12px 16px; font-size: 1.15em; font-weight: 500; }
header span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.body { flex: 1; min-height: 0; padding: 0 16px 16px; overflow: auto; display: flex; flex-direction: column; gap: 12px; }
footer { display: flex; justify-content: flex-end; gap: 8px; padding: 0 16px 16px; }
button { font: inherit; padding: 6px 16px; border-radius: var(--iob-border-radius); border: 1px solid var(--iob-primary); background: transparent; color: var(--iob-primary); cursor: pointer; }
button.primary { background: var(--iob-primary); color: var(--iob-primary-contrast); }
button.close { border: 0; padding: 2px 8px; font-size: 1.4em; line-height: 1; color: var(--iob-text-secondary); }
label { display: flex; flex-direction: column; gap: 4px; }
label.check { flex-direction: row; align-items: center; gap: 8px; }
input, select, textarea { font: inherit; accent-color: var(--iob-primary); }
.help { color: var(--iob-text-secondary); font-size: 0.85em; }
h3 { margin: 4px 0 0; font-size: 1em; }
p { margin: 0; }
hr { width: 100%; border: 0; border-top: 1px solid var(--iob-divider); margin: 0; }
[hidden] { display: none !important; }
`;function D(e){if(!e)return null;try{let t=Function(`data`,`return (${e});`);return e=>{try{return!!t(e)}catch{return!1}}}catch{return null}}function O(e){return typeof e==`string`?e:typeof e==`number`||typeof e==`boolean`?String(e):``}function k(e){let{input:t,setting:n}=e;if(t)return t instanceof HTMLInputElement&&t.type===`checkbox`?t.checked:t instanceof HTMLSelectElement?n.options?.[t.selectedIndex]?.value:t.value}function ee(e,t,n,r,i){let a={name:t,setting:n,box:e.createElement(`div`),hidden:D(n.hidden),disabled:D(n.disabled)},o=u(n.label,i);switch(n.type){case`header`:return a.box=e.createElement(`h3`),a.box.textContent=u(n.text,i)||o,a;case`staticText`:return a.box=e.createElement(`p`),a.box.textContent=u(n.text,i)||o,a;case`divider`:return a.box=e.createElement(`hr`),a}let s=e.createElement(`label`);a.box=s;let c=e.createElement(`span`);if(c.textContent=o||t,n.type===`checkbox`){let t=e.createElement(`input`);t.type=`checkbox`,t.checked=r===!0||r===`true`,s.className=`check`,s.append(t,c),a.input=t}else if(n.type===`select`){let t=e.createElement(`select`);for(let r of n.options||[]){let n=e.createElement(`option`);n.textContent=u(r.label,i),t.append(n)}let o=(n.options||[]).findIndex(e=>String(e.value)===O(r));t.selectedIndex=o===-1?0:o,s.append(c,t),a.input=t}else if(n.type===`text`&&(n.minRows||1)>1){let t=e.createElement(`textarea`);t.rows=n.minRows||2,t.value=O(r),s.append(c,t),a.input=t}else{let t=e.createElement(`input`),i=O(r);switch(n.type){case`number`:case`slider`:t.type=n.type===`slider`?`range`:`number`,n.min!==void 0&&(t.min=String(n.min)),n.max!==void 0&&(t.max=String(n.max)),t.step=n.step===void 0?`any`:String(n.step);break;case`password`:t.type=`password`;break;case`color`:t.type=!i||/^#[0-9a-f]{6}$/i.test(i)?`color`:`text`;break;default:t.type=`text`}if(t.value=i,t.type===`range`){let n=e.createElement(`output`);n.textContent=t.value,t.addEventListener(`input`,()=>n.textContent=t.value),c.append(`: `,n)}s.append(c,t),a.input=t}if(n.help){let t=e.createElement(`span`);t.className=`help`,t.textContent=u(n.help,i),s.append(t)}return a}function te(e,t={}){let n=t.lang||`en`,r=document,i=e=>T[e][n]||T[e].en||e,a=r.createElement(`div`);a.setAttribute(`data-iob-dialog`,``);let o=a.attachShadow({mode:`open`}),l=r.createElement(`style`);l.textContent=E;let f=r.createElement(`dialog`),p=x(t.theme);f.className=p.type===`dark`?`dark`:``;for(let[e,t]of Object.entries(w(p)))f.style.setProperty(e,t);e.width&&(f.style.width=`${e.width}px`),e.height&&(f.style.height=`${e.height}px`);let h=r.createElement(`form`),g=r.createElement(`header`),_=r.createElement(`span`);_.textContent=u(e.title,n);let v=r.createElement(`button`);v.type=`button`,v.className=`close`,v.title=i(`close`),v.setAttribute(`aria-label`,i(`close`)),v.textContent=`×`,g.append(_,v);let y=r.createElement(`div`);return y.className=`body`,h.append(g,y),f.append(h),o.append(l,f),new Promise(t=>{let l=!1,p=e=>{l||(l=!0,f.open&&f.close(),a.remove(),t(e))};if(v.addEventListener(`click`,()=>p(null)),f.addEventListener(`close`,()=>p(null)),h.addEventListener(`submit`,e=>e.preventDefault()),c(e)){let t={},a=[];for(let[t,i]of Object.entries(e.form.items||{})){let o=e.data?.[t]??i.default,s=ee(r,t,i,o,n);a.push(s),y.append(s.box)}let o=()=>{for(let e of a)e.input&&(t[e.name]=k(e));return t},s=()=>{let e=o();for(let t of a)t.box.hidden=t.hidden?t.hidden(e):!1,t.input&&(t.input.disabled=t.disabled?t.disabled(e):!1)};h.addEventListener(`input`,s),h.addEventListener(`change`,s),s();let c=a.find(e=>e.input&&!e.box.hidden&&!e.input.disabled);c?.input&&(c.input.autofocus=!0);let l=r.createElement(`footer`),f=r.createElement(`button`);f.type=`button`,f.textContent=u(e.cancel,n)||i(`cancel`),f.addEventListener(`click`,()=>p(null));let g=r.createElement(`button`);g.type=`submit`,g.className=`primary`,g.textContent=u(e.ok,n)||i(`ok`),l.append(f,g),h.append(l),h.addEventListener(`submit`,()=>p(m(d(e.form),o())))}else y.append(e.element),f.addEventListener(s,e=>p(e.detail??null));r.body.append(a),f.showModal(),o.activeElement&&o.activeElement!==v||(f.tabIndex=-1,f.focus())})}function A(e){return[...new Set(e.filter(e=>typeof e==`string`&&!!e))]}var j=[`socket`,`dialogs`,`theme`,`editMode`,`settings`,`value`],M=class extends HTMLElement{states={};objects={};#e=null;#t={};#n=x(`light`);#r=!1;#i=null;#a=void 0;#o=null;#s=!1;#c=(e,t)=>{this.#o?.states.includes(e)&&(this.states[e]=t||null,this.#_())};#l=(e,t)=>{this.#o?.objects.includes(e)&&(this.objects[e]=t||null,this.#d())};get socket(){return this.#e}set socket(e){this.#e=e||null,this.#d()}get settings(){return this.#t}set settings(e){this.#t=e||{},this.#d()}get theme(){return this.#n}set theme(e){let t=x(e);S(t,this.#n)||(this.#n=t,this.#u(),this.#_())}get editMode(){return this.#r}set editMode(e){let t=!!e;t!==this.#r&&(this.#r=t,this.#_())}get dialogs(){return this.#i}set dialogs(e){this.#i=e||null}get value(){return this.#a}set value(e){e!==this.#a&&(this.#a=e,this.#_())}connectedCallback(){for(let e of j)if(Object.prototype.hasOwnProperty.call(this,e)){let t=this[e];delete this[e],this[e]=t}this.#u(),this.#d()}disconnectedCallback(){this.#g()}getStateIds(e){return[]}getObjectIds(e){return[]}get systemLang(){return this.#e?.systemLang||`en`}text(e){return u(e,this.systemLang)}setState(e,t){return this.#e&&!this.#r?this.#e.setState(e,t):Promise.resolve()}changeValue(e){return this.#r||this.emit(`iob-change`,e)?!1:(this.value=e,!0)}emit(e,t){return this.dispatchEvent(new CustomEvent(e,{detail:t,bubbles:!0,composed:!0,cancelable:!0}))}async openDialog(e){if(this.#r)return null;let t=this.#i?await this.#i.open(e):await te(e,{lang:this.systemLang,theme:this.#n});return c(e)?t&&typeof t==`object`?m(d(e.form),t):null:t??null}#u(){for(let[e,t]of Object.entries(w(this.#n)))this.style.setProperty(e,t)}#d(){if(!this.isConnected)return;let e=this.#e,t=e?A(this.getStateIds(this.#t)):[],n=e?A(this.getObjectIds(this.#t)):[];this.#o&&this.#o.socket!==e&&this.#g();let r=this.#o?.states||[],i=this.#o?.objects||[],a=r.filter(e=>!t.includes(e)),o=i.filter(e=>!n.includes(e)),s=t.filter(e=>!r.includes(e)),c=n.filter(e=>!i.includes(e));e&&a.length&&e.unsubscribeState(a,this.#c),e&&o.length&&this.#h(e,o);for(let e of a)delete this.states[e];for(let e of[...a,...o])!t.includes(e)&&!n.includes(e)&&delete this.objects[e];this.#o=e&&(t.length||n.length)?{socket:e,states:t,objects:n}:null,e&&s.length&&this.#p(e,s),e&&c.length&&this.#m(e,c),this.#_()}#f(e,t,n){return this.#o?.socket===e&&this.#o[t].includes(n)}#p(e,t){e.subscribeState(t,this.#c).catch(e=>console.warn(`<${this.localName}>: cannot subscribe ${t.join(`, `)}: ${e}`));for(let n of t)e.getState(n).then(t=>{this.#f(e,`states`,n)&&this.states[n]===void 0&&(this.states[n]=t||null,this.#_())}).catch(()=>{}),e.getObject(n).then(t=>{this.#f(e,`states`,n)&&!this.#f(e,`objects`,n)&&(this.objects[n]=t||null,this.#_())}).catch(()=>{})}#m(e,t){e.subscribeObject(t,this.#l).catch(e=>console.warn(`<${this.localName}>: cannot subscribe the objects ${t.join(`, `)}: ${e}`));for(let n of t)e.getObject(n).then(t=>{this.#f(e,`objects`,n)&&(this.objects[n]=t||null,this.#d())}).catch(()=>{})}#h(e,t){e.unsubscribeObject(t,this.#l).catch(()=>{})}#g(){if(this.#o){let{socket:e,states:t,objects:n}=this.#o;t.length&&e.unsubscribeState(t,this.#c),n.length&&this.#h(e,n),this.#o=null}this.states={},this.objects={}}#_(){this.#s||(this.#s=!0,queueMicrotask(()=>{this.#s=!1,this.isConnected&&this.render()}))}};function N(e,t){let n=typeof e==`string`?e:e.tag;customElements.get(n)||customElements.define(n,t)}var P=16e3,F=30,I=P*F/1e3,ne=.02,re=400,ie={minStartLevel:400,minEndLevel:240,startFactor:3.5,endFactor:2,silenceMs:1e3,longSilenceMs:1600,longAfterMs:2500,minSpeechMs:250,speechGapMs:300,maxMs:3e4,preRollMs:400,tailMs:300,warmupMs:150};function ae(e){let t=0;for(let n=0;n<e.length;n++)t+=e[n]*e[n];return Math.sqrt(t/e.length)}var oe=class{opts;pending=/* @__PURE__ */ new Int16Array;floor=null;seenMs=0;history=[];frames=null;speech=!1;voicedMs=0;quietMs=0;spokenMs=0;level=0;constructor(e={}){this.opts={...ie,...e}}get startLevel(){return Math.max(this.opts.minStartLevel,(this.floor??0)*this.opts.startFactor)}get endLevel(){return Math.min(this.startLevel,Math.max(this.opts.minEndLevel,(this.floor??0)*this.opts.endFactor))}get hearing(){return this.frames!==null}reset(){this.pending=/* @__PURE__ */ new Int16Array,this.history=[],this.frames=null,this.speech=!1,this.voicedMs=0,this.quietMs=0,this.spokenMs=0,this.level=0}push(e){let t=e;this.pending.length&&(t=new Int16Array(this.pending.length+e.length),t.set(this.pending),t.set(e,this.pending.length));let n=0,r=null;for(;t.length-n>=I;){let e=t.slice(n,n+I);n+=I,r=this.frame(e)||r}return this.pending=t.slice(n),r}frame(e){let t=this.opts,n=ae(e);if(this.level=n,this.seenMs+=F,this.floor=this.floor===null?0:n<this.floor?n:this.frames?this.floor:this.floor+(n-this.floor)*ne,!this.frames)return this.history.push(e),this.history.length>Math.ceil(t.preRollMs/F)+1&&this.history.shift(),this.seenMs>=t.warmupMs&&n>=this.startLevel&&(this.frames=this.history,this.history=[],this.voicedMs=F,this.quietMs=0),null;this.frames.push(e);let r=n>=this.endLevel;if(!this.speech){if(r)this.voicedMs+=F,this.quietMs=0;else if(this.quietMs+=F,this.quietMs>=t.speechGapMs)return this.history=this.frames.slice(-(Math.ceil(t.preRollMs/F)+1)),this.frames=null,null;return this.voicedMs>=t.minSpeechMs&&(this.speech=!0,this.spokenMs=this.voicedMs+this.quietMs),null}this.spokenMs+=F,r?this.quietMs=0:this.quietMs+=F;let i=this.spokenMs-this.quietMs,a=t.longAfterMs&&i>=t.longAfterMs?t.longSilenceMs:t.silenceMs;if(this.quietMs>=a||this.spokenMs>=t.maxMs){let e=Math.max(0,Math.floor((this.quietMs-t.tailMs)/F)),n=this.frames.slice(0,this.frames.length-e);return this.reset(),se(n)}return null}};function se(e){let t=new Int16Array(e.reduce((e,t)=>e+t.length,0)),n=0;for(let r of e)t.set(r,n),n+=r.length;return t}var ce=class{pos=0;last=0;ratio;constructor(e){this.ratio=e/P}process(e){let t=new Int16Array(Math.ceil((e.length+1)/this.ratio)+1),n=0;for(;this.pos<e.length-1;){let r=Math.floor(this.pos),i=r<0?this.last:e[r],a=i+(e[r+1]-i)*(this.pos-r);t[n++]=Math.round(Math.max(-1,Math.min(1,a))*32767),this.pos+=this.ratio}return this.pos-=e.length,this.last=e.length?e[e.length-1]:this.last,t.subarray(0,n)}};function L(e){let t=new Uint8Array(e.buffer,e.byteOffset,e.byteLength),n=``;for(let e=0;e<t.length;e+=32768)n+=String.fromCharCode(...t.subarray(e,e+32768));return btoa(n)}var R=class{handlers;context=null;stream=null;node=null;resampler=null;detector=new oe;busy=!1;resumeAt=0;stopped=!1;constructor(e){this.handlers=e}static get supported(){return typeof window<`u`&&window.isSecureContext&&!!navigator.mediaDevices?.getUserMedia}async start(){let e=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:!0,noiseSuppression:!0,autoGainControl:!0,channelCount:1}});if(this.stopped){e.getTracks().forEach(e=>e.stop());return}let t=new AudioContext;t.state===`suspended`&&await t.resume();let n=t.createMediaStreamSource(e),r=t.createScriptProcessor(2048,1,1);this.resampler=new ce(t.sampleRate),r.onaudioprocess=e=>this.onAudio(e.inputBuffer.getChannelData(0)),n.connect(r),r.connect(t.destination),this.context=t,this.stream=e,this.node=r}stop(){this.stopped=!0,this.node&&(this.node.onaudioprocess=null,this.node.disconnect()),this.stream?.getTracks().forEach(e=>e.stop()),this.context?.close().catch(()=>{}),this.node=null,this.stream=null,this.context=null}onAudio(e){if(this.stopped||!this.resampler)return;let t=this.resampler.process(e);if(this.busy||Date.now()<this.resumeAt)return;let n=this.detector.push(t);this.handlers.onLevel?.(Math.min(1,this.detector.level/this.detector.startLevel),this.detector.hearing),n&&(this.busy=!0,this.handlers.onLevel?.(0,!1),this.handlers.onUtterance(n).catch(()=>{}).finally(()=>{this.busy=!1,this.resumeAt=Date.now()+re,this.detector.reset()}))}},z={stop:`custom_assistant_Stop word`,askReply:`custom_assistant_Reply to a question`,routine:`custom_assistant_Routine`,nlu:`custom_assistant_Rule-based NLU`,localLlm:`custom_assistant_Local LLM`,cloud:`custom_assistant_Cloud LLM`,none:`custom_assistant_Not understood`},B={stop:`#78909c`,askReply:`#78909c`,routine:`#00897b`,nlu:`#43a047`,localLlm:`#8e24aa`,cloud:`#1e88e5`,none:`#e53935`};({...z}),{...B};function V(e){return typeof e==`string`?`"${e}"`:JSON.stringify(e)}function H(e){return e===void 0?``:Math.abs(e)<1e3?`${Math.round(e)} ms`:`${(e/1e3).toFixed(1)} s`}var U={chat:`M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2M6 9h12v2H6zm8 5H6v-2h8zm4-6H6V6h12z`,speaker:`M17 2H7c-1.1 0-2 .9-2 2v16c0 1.1.9 1.99 2 1.99L17 22c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2m-5 2c1.1 0 2 .9 2 2s-.9 2-2 2c-1.11 0-2-.9-2-2s.89-2 2-2m0 16c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5m0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3`,send:`M2.01 21 23 12 2.01 3 2 10l15 2-15 2z`,mic:`M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3m5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72z`,dialog:`M9 13c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4m0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4m6.08-7.95c.84 1.18.84 2.71 0 3.89l1.68 1.69c2.02-2.02 2.02-5.07 0-7.27zM20.07 2l-1.63 1.63c2.77 3.02 2.77 7.56 0 10.74L20.07 16c3.9-3.89 3.91-9.95 0-14`,volumeOn:`M3 9v6h4l5 5V4L7 9zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02M14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77`,volumeOff:`M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63m2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71M4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9zM12 4 9.91 6.09 12 8.18z`,announce:`M18 11v2h4v-2zm-2 6.61c.96.71 2.21 1.65 3.2 2.39.4-.53.8-1.07 1.2-1.6-.99-.74-2.24-1.68-3.2-2.4-.4.54-.8 1.08-1.2 1.61M20.4 5.6c-.4-.53-.8-1.07-1.2-1.6-.99.74-2.24 1.68-3.2 2.4.4.53.8 1.07 1.2 1.6.96-.72 2.21-1.65 3.2-2.4M4 9c-1.1 0-2 .9-2 2v2c0 1.1.9 2 2 2h1v4h2v-4h1l5 3V6L8 9zm11.5 3c0-1.33-.58-2.53-1.5-3.35v6.69c.92-.81 1.5-2.01 1.5-3.34`};function W({path:e}){return/* @__PURE__ */ a(`svg`,{viewBox:`0 0 24 24`,"aria-hidden":`true`,children:/* @__PURE__ */ a(`path`,{d:e})})}function le({text:e,icon:t,editMode:n}){return/* @__PURE__ */ o(`div`,{className:`hint${n?` edit`:``}`,children:[/* @__PURE__ */ a(W,{path:t}),/* @__PURE__ */ a(`span`,{children:e})]})}var ue={chat:`transport_chat`,script:`transport_script`,state:`transport_state`},de={chat:`Chat`,script:`Script`,state:`State`,telegram:`Telegram`,esphome:`ESPHome`,udp:`UDP`,native:`ioBroker`,wyoming:`Wyoming`};function fe(e,t){try{return new Date(e).toLocaleTimeString(t,{hour:`2-digit`,minute:`2-digit`})}catch{return new Date(e).toLocaleTimeString()}}function G({role:e,ts:t,locale:n,header:r,children:i}){return/* @__PURE__ */ a(`div`,{className:`row ${e}`,children:/* @__PURE__ */ o(`div`,{className:`bubble`,children:[r,/* @__PURE__ */ a(`div`,{children:i}),/* @__PURE__ */ a(`div`,{className:`time`,children:fe(t,n)})]})})}function pe({entry:e,allRequests:t,details:n,word:r}){let i=[];if(t){let t=ue[e.transport];i.push(t?r(t):de[e.transport]||e.transport);let n=e.satellite||(e.transport===`chat`||e.transport===`state`?``:e.source);n&&i.push(n),e.room&&e.room!==n&&i.push(e.room)}return n&&e.wakeWord!==void 0&&i.push(`🎙 ${e.wakeWord||r(`followUp`)}`),n&&e.sttMs!==void 0&&i.push(`STT ${H(e.sttMs)}`),i.length?/* @__PURE__ */ a(`div`,{className:`chips`,children:i.map((e,t)=>/* @__PURE__ */ a(`span`,{className:`chip`,children:e},t))}):null}function me({entry:e,word:t}){return e.done?/* @__PURE__ */ o(`div`,{className:`details`,children:[/* @__PURE__ */ o(`div`,{className:`line`,children:[e.tier?/* @__PURE__ */ a(`span`,{className:`chip tier`,style:{"--tier":B[e.tier]},children:t(`tier_${e.tier}`)}):null,e.detail?/* @__PURE__ */ a(`span`,{className:`mono`,children:e.detail}):null,e.ms===void 0?null:/* @__PURE__ */ a(`span`,{children:H(e.ms)}),e.ttsMs===void 0?null:/* @__PURE__ */ o(`span`,{children:[`TTS `,H(e.ttsMs)]}),e.followUp?/* @__PURE__ */ a(`span`,{children:t(`waitsForReply`)}):null]}),e.written.map((e,n)=>/* @__PURE__ */ o(`div`,{className:`mono`,title:t(`States written`),children:[`✏️ `,e.id,` = `,V(e.value)]},n))]}):null}function K({word:e}){return/* @__PURE__ */ o(`div`,{className:`thinking`,children:[/* @__PURE__ */ a(`span`,{className:`spinner`}),/* @__PURE__ */ a(`span`,{children:e(`Thinking…`)})]})}function he({entry:e,allRequests:t,details:n,locale:r,word:s}){let c;return c=e.done?e.error?/* @__PURE__ */ a(G,{role:`error`,ts:e.ts+(e.ms||0),locale:r,children:e.error}):/* @__PURE__ */ a(G,{role:`assistant`,ts:e.ts+(e.ms||0),locale:r,children:e.answer||/* @__PURE__ */ a(`span`,{className:`silent`,children:s(`noSpokenAnswer`)})}):/* @__PURE__ */ a(K,{word:s}),/* @__PURE__ */ o(i,{children:[/* @__PURE__ */ a(G,{role:`user`,ts:e.ts,locale:r,header:/* @__PURE__ */ a(pe,{entry:e,allRequests:t,details:n,word:s}),children:e.question}),c,n?/* @__PURE__ */ a(me,{entry:e,word:s}):null]})}function ge(e,t){switch(e){case`listening`:return`Dialog: listening…`;case`hearing`:return`Dialog: hearing you…`;case`thinking`:return`Dialog: thinking…`;case`speaking`:return`Dialog: speaking…`;default:return t?`Listening…`:`Type a message…`}}function _e(e){let{items:i,ready:s,sending:c,dialog:l,listening:u,editMode:d,word:f,locale:p}=e,[m,h]=r(``),g=n(null),_=n(!0);t(()=>{let e=g.current;e&&_.current&&(e.scrollTop=e.scrollHeight)});let v=s&&!d&&!l,y=()=>{let t=m.trim();t&&v&&!c&&(e.onSend(t),h(``),_.current=!0)},b=e=>{e.key===`Enter`&&!e.shiftKey&&(e.preventDefault(),y())},x=`Dialog: everything you say becomes a question`;l?x=`End the dialog`:e.voiceEnabled||(x=`voiceOff`);let S=l===`hearing`?`hearing`:l===`speaking`?`speaking busy`:`busy`;return/* @__PURE__ */ o(`div`,{className:`chat${d?` edit`:``}`,children:[s?null:/* @__PURE__ */ a(`div`,{className:`banner`,children:f(`Start the assistant instance to chat.`)}),/* @__PURE__ */ o(`div`,{ref:g,className:`list`,onScroll:()=>{let e=g.current;_.current=!e||e.scrollHeight-e.scrollTop-e.clientHeight<60},children:[i.length?i.map(t=>t.entry?/* @__PURE__ */ a(he,{entry:t.entry,allRequests:e.allRequests,details:e.details,locale:p,word:f},t.key):/* @__PURE__ */ a(G,{role:t.message.role,ts:t.message.ts,locale:p,children:t.message.text},t.key)):/* @__PURE__ */ a(`div`,{className:`empty`,children:f(`No messages yet. Type a question below.`)}),e.thinking?/* @__PURE__ */ a(K,{word:f}):null]}),l?/* @__PURE__ */ a(`div`,{className:`level ${l===`listening`?``:S}`,children:/* @__PURE__ */ a(`span`,{style:l===`listening`||l===`hearing`?{width:`${Math.round(e.dialogLevel*100)}%`}:void 0})}):null,/* @__PURE__ */ o(`div`,{className:`composer`,children:[e.dialogSupported?/* @__PURE__ */ a(`button`,{type:`button`,className:`icon-btn ${l?`on`:`primary`}`,title:f(x),"aria-label":f(x),disabled:d||!l&&(!s||c||!e.voiceEnabled),onClick:e.onDialog,children:/* @__PURE__ */ a(W,{path:U.dialog})}):null,e.micSupported&&!l?/* @__PURE__ */ a(`button`,{type:`button`,className:`icon-btn ${u?`on`:`primary`}`,title:f(u?`Stop listening`:`Speak`),"aria-label":f(u?`Stop listening`:`Speak`),disabled:!s||c||d,onClick:e.onMic,children:/* @__PURE__ */ a(W,{path:U.mic})}):null,/* @__PURE__ */ a(`textarea`,{className:`field`,rows:1,value:m,placeholder:f(ge(l,u)),disabled:!v||c,onChange:e=>h(e.target.value),onKeyDown:b}),e.speakSupported?/* @__PURE__ */ a(`button`,{type:`button`,className:`icon-btn${e.speak?` primary`:``}`,title:f(e.speak?`Stop reading answers aloud`:`Read answers aloud`),"aria-label":f(e.speak?`Stop reading answers aloud`:`Read answers aloud`),"aria-pressed":e.speak,disabled:d,onClick:e.onSpeak,children:/* @__PURE__ */ a(W,{path:e.speak?U.volumeOn:U.volumeOff})}):null,/* @__PURE__ */ a(`button`,{type:`button`,className:`icon-btn filled`,title:f(`send`),"aria-label":f(`send`),disabled:!v||c||!m.trim(),onClick:y,children:/* @__PURE__ */ a(W,{path:U.send})})]})]})}var ve=`iob-assistant-chat`;function q(e){let t=(e||``).trim().replace(/^system\.adapter\./,``);return/^assistant\.\d+$/.test(t)?t:``}var J=[`Type a message…`,`Listening…`,`Thinking…`,`Speak`,`Stop listening`,`Read answers aloud`,`Stop reading answers aloud`,`No messages yet. Type a question below.`,`Start the assistant instance to chat.`,`States written`,`Dialog: listening…`,`Dialog: hearing you…`,`Dialog: thinking…`,`Dialog: speaking…`,`End the dialog`,`Dialog: everything you say becomes a question`,`The microphone could not be opened:`],Y={en:{"Type a message…":`Type a message…`,"Listening…":`Listening…`,"Thinking…":`Thinking…`,Speak:`Speak`,"Stop listening":`Stop listening`,"Read answers aloud":`Read answers aloud`,"Stop reading answers aloud":`Stop reading answers aloud`,"No messages yet. Type a question below.":`No messages yet. Type a question below.`,"Start the assistant instance to chat.":`Start the assistant instance to chat.`,"States written":`States written`,"Dialog: listening…":`Dialog: listening …`,"Dialog: hearing you…":`Dialog: hearing you …`,"Dialog: thinking…":`Dialog: thinking …`,"Dialog: speaking…":`Dialog: speaking …`,"End the dialog":`End the dialog`,"Dialog: everything you say becomes a question":`Dialog: everything you say becomes a question — until you end it`,"The microphone could not be opened:":`The microphone could not be opened:`},de:{"Type a message…":`Nachricht eingeben …`,"Listening…":`Höre zu …`,"Thinking…":`Denkt nach …`,Speak:`Sprechen`,"Stop listening":`Zuhören beenden`,"Read answers aloud":`Antworten vorlesen`,"Stop reading answers aloud":`Vorlesen beenden`,"No messages yet. Type a question below.":`Noch keine Nachrichten. Geben Sie unten eine Frage ein.`,"Start the assistant instance to chat.":`Starten Sie die Assistenteninstanz, um zu chatten.`,"States written":`Geschriebene States`,"Dialog: listening…":`Dialog: höre zu …`,"Dialog: hearing you…":`Dialog: höre dich …`,"Dialog: thinking…":`Dialog: denke nach …`,"Dialog: speaking…":`Dialog: spreche …`,"End the dialog":`Dialog beenden`,"Dialog: everything you say becomes a question":`Dialog: Alles, was du sagst, wird zur Frage – bis du ihn beendest`,"The microphone could not be opened:":`Das Mikrofon ließ sich nicht öffnen:`},ru:{"Type a message…":`Введите сообщение…`,"Listening…":`Слушаю…`,"Thinking…":`Размышления…`,Speak:`Говорить`,"Stop listening":`Прекратите слушать`,"Read answers aloud":`Прочитайте ответы вслух.`,"Stop reading answers aloud":`Прекратите зачитывать ответы вслух.`,"No messages yet. Type a question below.":`Сообщений пока нет. Задайте вопрос ниже.`,"Start the assistant instance to chat.":`Запустите экземпляр ассистента для начала чата.`,"States written":`Записанные состояния`,"Dialog: listening…":`Диалог: слушаю …`,"Dialog: hearing you…":`Диалог: слышу вас …`,"Dialog: thinking…":`Диалог: думаю …`,"Dialog: speaking…":`Диалог: говорю …`,"End the dialog":`Завершить диалог`,"Dialog: everything you say becomes a question":`Диалог: всё, что вы скажете, станет вопросом — пока вы его не завершите`,"The microphone could not be opened:":`Не удалось открыть микрофон:`},pt:{"Type a message…":`Digite uma mensagem…`,"Listening…":`Audição…`,"Thinking…":`Pensamento…`,Speak:`Falar`,"Stop listening":`Pare de ouvir`,"Read answers aloud":`Leia as respostas em voz alta.`,"Stop reading answers aloud":`Pare de ler as respostas em voz alta.`,"No messages yet. Type a question below.":`Ainda não há mensagens. Digite sua pergunta abaixo.`,"Start the assistant instance to chat.":`Inicie a instância do assistente para conversar.`,"States written":`Estados escritos`,"Dialog: listening…":`Diálogo: a ouvir …`,"Dialog: hearing you…":`Diálogo: estou a ouvir-te …`,"Dialog: thinking…":`Diálogo: a pensar …`,"Dialog: speaking…":`Diálogo: a falar …`,"End the dialog":`Terminar o diálogo`,"Dialog: everything you say becomes a question":`Diálogo: tudo o que disseres torna-se uma pergunta, até o terminares`,"The microphone could not be opened:":`Não foi possível abrir o microfone:`},nl:{"Type a message…":`Typ een bericht…`,"Listening…":`Luisteren…`,"Thinking…":`Aan het nadenken…`,Speak:`Spreken`,"Stop listening":`Stop met luisteren`,"Read answers aloud":`Lees de antwoorden hardop voor.`,"Stop reading answers aloud":`Stop met het hardop voorlezen van antwoorden.`,"No messages yet. Type a question below.":`Nog geen berichten. Typ hieronder een vraag.`,"Start the assistant instance to chat.":`Start de assistent-instantie om te chatten.`,"States written":`Geschreven states`,"Dialog: listening…":`Dialoog: luistert …`,"Dialog: hearing you…":`Dialoog: hoort je …`,"Dialog: thinking…":`Dialoog: denkt na …`,"Dialog: speaking…":`Dialoog: spreekt …`,"End the dialog":`Dialoog beëindigen`,"Dialog: everything you say becomes a question":`Dialoog: alles wat je zegt wordt een vraag, totdat je hem beëindigt`,"The microphone could not be opened:":`De microfoon kon niet worden geopend:`},fr:{"Type a message…":`Saisissez un message…`,"Listening…":`Écoute…`,"Thinking…":`Pensée…`,Speak:`Parler`,"Stop listening":`Arrêtez d'écouter`,"Read answers aloud":`Lisez les réponses à voix haute`,"Stop reading answers aloud":`Arrêtez de lire les réponses à voix haute`,"No messages yet. Type a question below.":`Aucun message pour l'instant. Posez votre question ci-dessous.`,"Start the assistant instance to chat.":`Démarrez l'instance de l'assistant pour discuter.`,"States written":`États écrits`,"Dialog: listening…":`Dialogue : à l’écoute …`,"Dialog: hearing you…":`Dialogue : je t’entends …`,"Dialog: thinking…":`Dialogue : réflexion …`,"Dialog: speaking…":`Dialogue : je parle …`,"End the dialog":`Terminer le dialogue`,"Dialog: everything you say becomes a question":`Dialogue : tout ce que tu dis devient une question, jusqu’à ce que tu y mettes fin`,"The microphone could not be opened:":`Impossible d’ouvrir le microphone :`},it:{"Type a message…":`Digita un messaggio…`,"Listening…":`Ascolto…`,"Thinking…":`Pensiero…`,Speak:`Parlare`,"Stop listening":`Smetti di ascoltare`,"Read answers aloud":`Leggi le risposte ad alta voce`,"Stop reading answers aloud":`Smetti di leggere le risposte ad alta voce`,"No messages yet. Type a question below.":`Nessun messaggio ancora. Scrivi una domanda qui sotto.`,"Start the assistant instance to chat.":`Avvia l'assistente per chattare.`,"States written":`Stati scritti`,"Dialog: listening…":`Dialogo: in ascolto …`,"Dialog: hearing you…":`Dialogo: ti sento …`,"Dialog: thinking…":`Dialogo: sto pensando …`,"Dialog: speaking…":`Dialogo: sto parlando …`,"End the dialog":`Termina il dialogo`,"Dialog: everything you say becomes a question":`Dialogo: tutto ciò che dici diventa una domanda, finché non lo termini`,"The microphone could not be opened:":`Impossibile aprire il microfono:`},es:{"Type a message…":`Escribe un mensaje…`,"Listening…":`Escuchando…`,"Thinking…":`Pensamiento…`,Speak:`Hablar`,"Stop listening":`Deja de escuchar`,"Read answers aloud":`Lee las respuestas en voz alta.`,"Stop reading answers aloud":`Deja de leer las respuestas en voz alta.`,"No messages yet. Type a question below.":`Aún no hay mensajes. Escribe tu pregunta a continuación.`,"Start the assistant instance to chat.":`Inicia la instancia del asistente para chatear.`,"States written":`Estados escritos`,"Dialog: listening…":`Diálogo: escuchando …`,"Dialog: hearing you…":`Diálogo: te oigo …`,"Dialog: thinking…":`Diálogo: pensando …`,"Dialog: speaking…":`Diálogo: hablando …`,"End the dialog":`Terminar el diálogo`,"Dialog: everything you say becomes a question":`Diálogo: todo lo que digas se convierte en una pregunta, hasta que lo termines`,"The microphone could not be opened:":`No se pudo abrir el micrófono:`},pl:{"Type a message…":`Wpisz wiadomość…`,"Listening…":`Słuchający…`,"Thinking…":`Myślący…`,Speak:`Mówić`,"Stop listening":`Przestań słuchać`,"Read answers aloud":`Przeczytaj odpowiedzi na głos`,"Stop reading answers aloud":`Przestań czytać odpowiedzi na głos`,"No messages yet. Type a question below.":`Brak wiadomości. Wpisz pytanie poniżej.`,"Start the assistant instance to chat.":`Uruchom asystenta, aby rozpocząć rozmowę.`,"States written":`Zapisane stany`,"Dialog: listening…":`Dialog: słucham …`,"Dialog: hearing you…":`Dialog: słyszę cię …`,"Dialog: thinking…":`Dialog: myślę …`,"Dialog: speaking…":`Dialog: mówię …`,"End the dialog":`Zakończ dialog`,"Dialog: everything you say becomes a question":`Dialog: wszystko, co powiesz, staje się pytaniem — dopóki go nie zakończysz`,"The microphone could not be opened:":`Nie udało się otworzyć mikrofonu:`},uk:{"Type a message…":`Введіть повідомлення…`,"Listening…":`Слухання…`,"Thinking…":`Мислення…`,Speak:`Говоріть`,"Stop listening":`Перестань слухати`,"Read answers aloud":`Прочитайте відповіді вголос`,"Stop reading answers aloud":`Перестаньте читати відповіді вголос`,"No messages yet. Type a question below.":`Поки що немає повідомлень. Введіть запитання нижче.`,"Start the assistant instance to chat.":`Запустіть екземпляр помічника для спілкування в чаті.`,"States written":`Записані стани`,"Dialog: listening…":`Діалог: слухаю …`,"Dialog: hearing you…":`Діалог: чую вас …`,"Dialog: thinking…":`Діалог: думаю …`,"Dialog: speaking…":`Діалог: говорю …`,"End the dialog":`Завершити діалог`,"Dialog: everything you say becomes a question":`Діалог: усе, що ви скажете, стане запитанням — доки ви його не завершите`,"The microphone could not be opened:":`Не вдалося відкрити мікрофон:`},"zh-cn":{"Type a message…":`输入消息…`,"Listening…":`正在听……`,"Thinking…":`思维…`,Speak:`说话`,"Stop listening":`别听了`,"Read answers aloud":`大声朗读答案`,"Stop reading answers aloud":`停止大声朗读答案`,"No messages yet. Type a question below.":`暂无消息。请在下方输入问题。`,"Start the assistant instance to chat.":`启动助手实例进行聊天。`,"States written":`写入的状态`,"Dialog: listening…":`对话：正在聆听 …`,"Dialog: hearing you…":`对话：正在听你说 …`,"Dialog: thinking…":`对话：正在思考 …`,"Dialog: speaking…":`对话：正在说话 …`,"End the dialog":`结束对话`,"Dialog: everything you say becomes a question":`对话：你说的每句话都会成为一个问题，直到你结束对话`,"The microphone could not be opened:":`无法打开麦克风：`}},X={en:{chooseInstance:`Choose an instance of the assistant in the settings`},de:{chooseInstance:`Instanz des Assistenten in den Einstellungen wählen`},ru:{chooseInstance:`Выберите экземпляр ассистента в настройках`},pt:{chooseInstance:`Escolha uma instância do assistente nas configurações`},nl:{chooseInstance:`Kies een instantie van de assistent in de instellingen`},fr:{chooseInstance:`Choisissez une instance de l'assistant dans les paramètres`},it:{chooseInstance:`Scegli un'istanza dell'assistente nelle impostazioni`},es:{chooseInstance:`Elija una instancia del asistente en la configuración`},pl:{chooseInstance:`Wybierz instancję asystenta w ustawieniach`},uk:{chooseInstance:`Виберіть екземпляр асистента в налаштуваннях`},"zh-cn":{chooseInstance:`请在设置中选择助手实例`}};function ye(e,t){return n=>r=>r in e.en?e[n]?.[r]||e.en[r]:r===`chooseInstance`?X[n]?.chooseInstance||X.en.chooseInstance:t.includes(r)&&(Y[n]?.[r]||Y.en?.[r])||r}function Z(e){return{de:`de-DE`,en:`en-US`,ru:`ru-RU`,pt:`pt-PT`,nl:`nl-NL`,fr:`fr-FR`,it:`it-IT`,es:`es-ES`,pl:`pl-PL`,uk:`uk-UA`,"zh-cn":`zh-CN`}[e]||e||`en-US`}var be=ye({en:{send:`Send`,noSpokenAnswer:`(no spoken answer)`,noAnswer:`No answer from the assistant`,voiceOff:`Dialog mode needs speech recognition: switch on voice in the instance settings of the assistant`,waitsForReply:`waits for a reply`,followUp:`follow-up`,tier_stop:`Stop word`,tier_askReply:`Reply to a question`,tier_routine:`Routine`,tier_nlu:`Rule-based NLU`,tier_localLlm:`Local LLM`,tier_cloud:`Cloud LLM`,tier_none:`Not understood`,transport_chat:`Chat`,transport_script:`Script`,transport_state:`State`},de:{send:`Senden`,noSpokenAnswer:`(keine gesprochene Antwort)`,noAnswer:`Keine Antwort vom Assistenten`,voiceOff:`Der Dialogmodus braucht Spracherkennung: Sprache in den Instanzeinstellungen des Assistenten einschalten`,waitsForReply:`wartet auf Antwort`,followUp:`Nachfrage`,tier_stop:`Stoppwort`,tier_askReply:`Antwort auf Rückfrage`,tier_routine:`Routine`,tier_nlu:`Regel-NLU`,tier_localLlm:`Lokales LLM`,tier_cloud:`Cloud-LLM`,tier_none:`Nicht verstanden`,transport_chat:`Chat`,transport_script:`Skript`,transport_state:`Datenpunkt`},ru:{send:`Отправить`,noSpokenAnswer:`(без голосового ответа)`,noAnswer:`Нет ответа от ассистента`,voiceOff:`Для режима диалога нужно распознавание речи: включите голос в настройках экземпляра ассистента`,waitsForReply:`ждёт ответа`,followUp:`продолжение`,tier_stop:`Стоп-слово`,tier_askReply:`Ответ на вопрос`,tier_routine:`Сценарий`,tier_nlu:`NLU по правилам`,tier_localLlm:`Локальная LLM`,tier_cloud:`Облачная LLM`,tier_none:`Не понято`,transport_chat:`Чат`,transport_script:`Скрипт`,transport_state:`Состояние`},pt:{send:`Enviar`,noSpokenAnswer:`(sem resposta falada)`,noAnswer:`Sem resposta do assistente`,voiceOff:`O modo de diálogo precisa de reconhecimento de voz: ative a voz nas configurações da instância do assistente`,waitsForReply:`aguarda resposta`,followUp:`seguimento`,tier_stop:`Palavra de paragem`,tier_askReply:`Resposta a uma pergunta`,tier_routine:`Rotina`,tier_nlu:`NLU por regras`,tier_localLlm:`LLM local`,tier_cloud:`LLM na nuvem`,tier_none:`Não entendido`,transport_chat:`Chat`,transport_script:`Script`,transport_state:`Estado`},nl:{send:`Verzenden`,noSpokenAnswer:`(geen gesproken antwoord)`,noAnswer:`Geen antwoord van de assistent`,voiceOff:`De dialoogmodus heeft spraakherkenning nodig: schakel spraak in bij de instantie-instellingen van de assistent`,waitsForReply:`wacht op antwoord`,followUp:`vervolgvraag`,tier_stop:`Stopwoord`,tier_askReply:`Antwoord op een vraag`,tier_routine:`Routine`,tier_nlu:`Regelgebaseerde NLU`,tier_localLlm:`Lokaal LLM`,tier_cloud:`Cloud-LLM`,tier_none:`Niet begrepen`,transport_chat:`Chat`,transport_script:`Script`,transport_state:`Datapunt`},fr:{send:`Envoyer`,noSpokenAnswer:`(pas de réponse orale)`,noAnswer:`Pas de réponse de l'assistant`,voiceOff:`Le mode dialogue nécessite la reconnaissance vocale : activez la voix dans les paramètres de l'instance de l'assistant`,waitsForReply:`attend une réponse`,followUp:`suite`,tier_stop:`Mot d'arrêt`,tier_askReply:`Réponse à une question`,tier_routine:`Routine`,tier_nlu:`NLU à règles`,tier_localLlm:`LLM local`,tier_cloud:`LLM cloud`,tier_none:`Non compris`,transport_chat:`Chat`,transport_script:`Script`,transport_state:`État`},it:{send:`Invia`,noSpokenAnswer:`(nessuna risposta parlata)`,noAnswer:`Nessuna risposta dall'assistente`,voiceOff:`La modalità dialogo richiede il riconoscimento vocale: attiva la voce nelle impostazioni dell'istanza dell'assistente`,waitsForReply:`attende una risposta`,followUp:`seguito`,tier_stop:`Parola di stop`,tier_askReply:`Risposta a una domanda`,tier_routine:`Routine`,tier_nlu:`NLU a regole`,tier_localLlm:`LLM locale`,tier_cloud:`LLM cloud`,tier_none:`Non capito`,transport_chat:`Chat`,transport_script:`Script`,transport_state:`Stato`},es:{send:`Enviar`,noSpokenAnswer:`(sin respuesta hablada)`,noAnswer:`Sin respuesta del asistente`,voiceOff:`El modo diálogo necesita reconocimiento de voz: active la voz en la configuración de la instancia del asistente`,waitsForReply:`espera respuesta`,followUp:`seguimiento`,tier_stop:`Palabra de parada`,tier_askReply:`Respuesta a una pregunta`,tier_routine:`Rutina`,tier_nlu:`NLU por reglas`,tier_localLlm:`LLM local`,tier_cloud:`LLM en la nube`,tier_none:`No entendido`,transport_chat:`Chat`,transport_script:`Script`,transport_state:`Estado`},pl:{send:`Wyślij`,noSpokenAnswer:`(brak odpowiedzi głosowej)`,noAnswer:`Brak odpowiedzi od asystenta`,voiceOff:`Tryb dialogu wymaga rozpoznawania mowy: włącz głos w ustawieniach instancji asystenta`,waitsForReply:`czeka na odpowiedź`,followUp:`kontynuacja`,tier_stop:`Słowo stop`,tier_askReply:`Odpowiedź na pytanie`,tier_routine:`Rutyna`,tier_nlu:`NLU oparte na regułach`,tier_localLlm:`Lokalny LLM`,tier_cloud:`LLM w chmurze`,tier_none:`Nie zrozumiano`,transport_chat:`Czat`,transport_script:`Skrypt`,transport_state:`Stan`},uk:{send:`Надіслати`,noSpokenAnswer:`(без голосової відповіді)`,noAnswer:`Немає відповіді від асистента`,voiceOff:`Для режиму діалогу потрібне розпізнавання мовлення: увімкніть голос у налаштуваннях екземпляра асистента`,waitsForReply:`чекає на відповідь`,followUp:`продовження`,tier_stop:`Стоп-слово`,tier_askReply:`Відповідь на запитання`,tier_routine:`Сценарій`,tier_nlu:`NLU за правилами`,tier_localLlm:`Локальна LLM`,tier_cloud:`Хмарна LLM`,tier_none:`Не зрозуміло`,transport_chat:`Чат`,transport_script:`Скрипт`,transport_state:`Стан`},"zh-cn":{send:`发送`,noSpokenAnswer:`（无语音回答）`,noAnswer:`助手没有回答`,voiceOff:`对话模式需要语音识别：请在助手实例设置中开启语音`,waitsForReply:`等待回复`,followUp:`追问`,tier_stop:`停止词`,tier_askReply:`回复提问`,tier_routine:`例程`,tier_nlu:`基于规则的 NLU`,tier_localLlm:`本地 LLM`,tier_cloud:`云端 LLM`,tier_none:`未理解`,transport_chat:`聊天`,transport_script:`脚本`,transport_state:`状态`}},J);function Q(){if(typeof window>`u`||!window.isSecureContext)return null;let e=window;return e.SpeechRecognition||e.webkitSpeechRecognition||null}function $(){return typeof window<`u`&&`speechSynthesis`in window&&!!window.speechSynthesis}function xe(){$()&&window.speechSynthesis.cancel()}var Se=`
:host {
    display: block;
    width: 100%;
    height: 100%;
}
.mount {
    width: 100%;
    height: 100%;
    /* the size of the box does not depend on what is in it */
    container-type: size;
}
.edit {
    pointer-events: none;
}
.hint {
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    padding: 8px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: clamp(2px, 3cqmin, 8px);
    overflow: hidden;
    text-align: center;
    color: var(--iob-text-secondary);
    font-size: clamp(10px, 6cqmin, 15px);
}
.hint svg {
    width: clamp(16px, 14cqmin, 36px);
    height: clamp(16px, 14cqmin, 36px);
    fill: currentColor;
    flex: none;
}
.icon-btn {
    flex: none;
    box-sizing: border-box;
    width: 36px;
    height: 36px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: transparent;
    color: inherit;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
}
.icon-btn svg {
    width: 22px;
    height: 22px;
    fill: currentColor;
}
.icon-btn:hover:not(:disabled) {
    background: color-mix(in srgb, currentColor 10%, transparent);
}
.icon-btn:focus-visible {
    outline: 2px solid var(--iob-primary);
    outline-offset: -2px;
}
.icon-btn:disabled {
    opacity: 0.38;
    cursor: default;
}
.icon-btn.primary {
    color: var(--iob-primary);
}
.icon-btn.on {
    color: var(--iob-error);
}
.icon-btn.filled {
    background: var(--iob-primary);
    color: var(--iob-primary-contrast);
}
.icon-btn.filled:hover:not(:disabled) {
    background: color-mix(in srgb, var(--iob-primary) 85%, currentColor);
}
.field {
    flex: 1;
    min-width: 0;
    box-sizing: border-box;
    margin: 0;
    padding: 7px 12px;
    font: inherit;
    line-height: 1.4;
    color: inherit;
    background: transparent;
    border: 1px solid var(--iob-divider);
    border-radius: 18px;
    outline: none;
    resize: none;
    field-sizing: content;
    min-height: 36px;
    max-height: 7em;
}
.field:focus {
    border-color: var(--iob-primary);
}
.field:disabled {
    opacity: 0.6;
}
.field::placeholder {
    color: var(--iob-text-secondary);
}
.spinner {
    flex: none;
    width: 12px;
    height: 12px;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
}
@keyframes spin {
    to {
        transform: rotate(360deg);
    }
}

.chat {
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    padding: 6px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    overflow: hidden;
}
.banner {
    flex: none;
    padding: 2px 6px;
    color: var(--iob-warning);
    font-size: 0.85em;
}
.list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 2px;
}
.empty {
    margin: auto;
    padding: 16px;
    text-align: center;
    color: var(--iob-text-secondary);
}
.row {
    display: flex;
    justify-content: flex-start;
}
.row.user {
    justify-content: flex-end;
}
.bubble {
    max-width: 82%;
    box-sizing: border-box;
    padding: 6px 10px;
    border-radius: 14px;
    border-bottom-left-radius: 4px;
    background: color-mix(in srgb, currentColor 9%, transparent);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    line-height: 1.4;
}
.user .bubble {
    border-radius: 14px;
    border-bottom-right-radius: 4px;
    background: var(--iob-primary);
    color: var(--iob-primary-contrast);
}
.error .bubble {
    background: color-mix(in srgb, var(--iob-error) 14%, transparent);
    color: var(--iob-error);
}
.silent {
    font-style: italic;
    opacity: 0.7;
}
.time {
    margin-top: 2px;
    text-align: right;
    font-size: 0.7em;
    opacity: 0.65;
}
.chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-bottom: 3px;
}
.chip {
    padding: 0 7px;
    border-radius: 999px;
    background: color-mix(in srgb, currentColor 20%, transparent);
    font-size: 0.72em;
    line-height: 1.6;
    white-space: nowrap;
}
.chip.tier {
    background: var(--tier);
    color: #fff;
}
.details {
    margin: 0 0 4px 8px;
    padding-left: 8px;
    border-left: 2px solid var(--iob-divider);
    display: flex;
    flex-direction: column;
    gap: 2px;
    color: var(--iob-text-secondary);
    font-size: 0.78em;
}
.details .line {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
}
.mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    overflow-wrap: anywhere;
}
.thinking {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    color: var(--iob-text-secondary);
}
.level {
    flex: none;
    height: 3px;
    border-radius: 2px;
    overflow: hidden;
    background: color-mix(in srgb, var(--iob-primary) 22%, transparent);
}
.level span {
    display: block;
    height: 100%;
    background: var(--iob-primary);
    transition: width 0.1s linear;
}
.level.hearing span {
    background: var(--iob-error);
}
.level.busy span {
    width: 35%;
    animation: slide 1.2s ease-in-out infinite;
}
.level.speaking span {
    background: var(--iob-secondary);
}
@keyframes slide {
    from {
        transform: translateX(-100%);
    }
    to {
        transform: translateX(300%);
    }
}
.composer {
    flex: none;
    display: flex;
    align-items: flex-end;
    gap: 4px;
}
@container (max-height: 180px) {
    .time {
        display: none;
    }
}
@container (max-width: 260px) {
    .bubble {
        max-width: 92%;
    }
}
`;N(ve,class extends M{#e;#t=``;#n=/* @__PURE__ */ new Map;#r=[];#i=0;#a=null;#o=null;#s=null;#c=!1;#l=!1;#u=null;#d=null;#f=null;#p=``;#m=0;#h=0;#g=null;constructor(){super();let t=this.attachShadow({mode:`open`}),n=document.createElement(`style`);n.textContent=Se;let r=document.createElement(`div`);r.className=`mount`,t.append(n,r),this.#e=e(r)}disconnectedCallback(){super.disconnectedCallback(),this.#N(),this.#s=null}getStateIds(e){let t=q(e.instance);return t?[`system.adapter.${t}.alive`,`${t}.journal.last`]:[]}getObjectIds(e){let t=q(e.instance);return t?[`system.adapter.${t}`]:[]}get#_(){return!!this.#t&&!!this.states[`system.adapter.${this.#t}.alive`]?.val}get#v(){return this.objects[`system.adapter.${this.#t}`]?.native||{}}get#y(){return Z(this.#v.voiceLanguage||this.systemLang)}get#b(){return this.#u??!!this.settings.speak}get#x(){return be(this.systemLang)}render(){let e=q(this.settings.instance);if(e!==this.#t&&this.#S(e),!e){this.#e.render(/* @__PURE__ */ a(le,{text:this.#x(`chooseInstance`),icon:U.chat,editMode:this.editMode}));return}this.#C();let t=this.socket;(!this.#_||this.editMode)&&this.#N(),this.#_?t&&this.#s!==t&&(this.#s=t,this.#w(e,t)):this.#s=null,this.#D()}#S(e){this.#N(),this.#t=e,this.#n.clear(),this.#r=[],this.#a=null,this.#o=null,this.#s=null,this.#c=!1,this.#l=!1,this.#u=null}#C(){let e=this.states[`${this.#t}.journal.last`];if(e&&e!==this.#o&&(this.#o=e,this.#a!==!1&&typeof e.val==`string`&&e.val))try{let t=JSON.parse(e.val);t?.id&&this.#n.set(t.id,t)}catch{}}async#w(e,t){let[n,r]=await Promise.all([t.sendTo(e,`getJournal`,{}).catch(()=>void 0),t.sendTo(e,`ttsAvailable`,{}).catch(()=>void 0)]);if(e===this.#t&&t===this.socket){if(this.#c=!!r?.available,this.#a=n?.enabled!==void 0&&n.enabled,this.#a)for(let e of n?.entries||[])e?.id&&!this.#n.has(e.id)&&this.#n.set(e.id,e);else this.#n.clear();this.#D()}}#T(e,t,n=Date.now()){this.#r.push({key:`m${++this.#i}`,ts:n,message:{role:e,text:t,ts:n}})}#E(){let e=!!this.settings.allRequests,t=[...this.#r];for(let n of this.#n.values())(e||n.source===`chat`)&&t.push({key:n.id,ts:n.ts,entry:n});return t.sort((e,t)=>e.ts-t.ts),t.slice(-200)}#D(){if(!this.#t)return;let e=this.#v;this.#e.render(/* @__PURE__ */ a(_e,{items:this.#E(),allRequests:!!this.settings.allRequests,details:!!this.settings.details,ready:this.#_,thinking:this.#l&&!this.#a&&!this.#p,sending:this.#l,micSupported:!!Q(),listening:!!this.#d,dialogSupported:R.supported,voiceEnabled:!!e.voiceEnabled,dialog:this.#p,dialogLevel:this.#m,speakSupported:$()||this.#c,speak:this.#b,editMode:this.editMode,locale:Z(this.systemLang),word:this.#x,onSend:e=>void this.#O(e),onMic:()=>this.#A(),onDialog:()=>void this.#j(),onSpeak:()=>this.#k()}))}async#O(e){let t=this.#t,n=this.socket;if(!t||!n||this.editMode||this.#l||!this.#_)return;let r=!!this.#a,i=Date.now();this.#l=!0,r||this.#T(`user`,e,i),this.#D();try{let a=await n.sendTo(t,`ask`,{text:e});if(t!==this.#t)return;r&&!a?.journaled&&this.#T(`user`,e,i),a?a.error===void 0?a.journaled||this.#T(`assistant`,a.answer??``):a.journaled||this.#T(`error`,a.error):this.#T(`error`,this.#x(`noAnswer`)),a?.answer&&this.#b&&this.#I(a.answer)}catch(e){t===this.#t&&this.#T(`error`,String(e?.message||e))}finally{t===this.#t&&(this.#l=!1,this.#D())}}#k(){if(this.editMode)return;let e=!this.#b;e||this.#g?.(),this.#u=e,this.#D()}#A(){if(this.#d){this.#d.stop();return}let e=Q();if(!e||this.editMode||!this.#_)return;let t=new e;t.lang=this.#y,t.interimResults=!1,t.continuous=!1,t.onresult=e=>{let t=e.results?.[0]?.[0]?.transcript||``;t&&this.#O(t)};let n=()=>{this.#d===t&&(this.#d=null,this.#D())};t.onerror=n,t.onend=n,this.#d=t,this.#D();try{t.start()}catch{n()}}async#j(){if(this.#f){this.#M(),this.#D();return}if(this.editMode||!this.#_||!this.#v.voiceEnabled)return;this.#d?.stop(),this.#g?.();let e=new R({onUtterance:e=>this.#F(e),onLevel:(e,t)=>this.#P(e,t)});this.#f=e,this.#p=`listening`,this.#m=0,this.#D();try{await e.start()}catch(t){this.#f===e&&this.#M(),this.#T(`error`,`${this.#x(`The microphone could not be opened:`)} ${t.message}`),this.#D()}}#M(){this.#f?.stop(),this.#f=null,this.#g?.(),this.#p=``,this.#m=0}#N(){if(this.#d){let e=this.#d;this.#d=null;try{e.stop()}catch{}}this.#f&&this.#M(),this.#g?.()}#P(e,t){if(this.#p!==`listening`&&this.#p!==`hearing`)return;let n=Date.now();n-this.#h<100&&t===(this.#p===`hearing`)||(this.#h=n,this.#m=e,this.#p=t?`hearing`:`listening`,this.#D())}async#F(e){let t=this.#f,n=this.#t,r=this.socket;if(!t||!r||!this.#_)return;let i=!!this.#a;this.#p=`thinking`,this.#m=0,this.#l=!0,this.#D();try{let a=await r.sendTo(n,`ask`,{audio:L(e),format:`pcm`,sampleRate:P,spoken:!0});if(this.#f!==t)return;if(!a){this.#T(`error`,this.#x(`noAnswer`));return}if(a.heard===``)return;i&&a.journaled||(a.heard&&this.#T(`user`,a.heard),a.error===void 0?this.#T(`assistant`,a.answer??``):this.#T(`error`,a.error)),a.answer&&(this.#p=`speaking`,this.#D(),await this.#I(a.answer))}catch(e){n===this.#t&&this.#T(`error`,String(e?.message||e))}finally{n===this.#t&&(this.#l=!1,this.#f===t&&(this.#p=`listening`,this.#m=0),this.#D())}}#I(e){this.#g?.();let t=this.#t,n=this.socket,r=this.#y;return new Promise(i=>{let a=!1,o=null,s,c=null,l=()=>{a||(a=!0,clearTimeout(s),this.#g===c&&(this.#g=null),i())};c=()=>{o?.pause(),xe(),l()},this.#g=c,s=setTimeout(l,15e3+e.length*120);let u=()=>{if(a||!$()){l();return}let t=new SpeechSynthesisUtterance(e);t.lang=r,t.onend=l,t.onerror=l,window.speechSynthesis.cancel(),window.speechSynthesis.speak(t)};!this.#c||!n?u():(async()=>{try{let r=await n.sendTo(t,`tts`,{text:e});if(a)return;if(r?.audio){o=new Audio(`data:${r.mime||`audio/wav`};base64,${r.audio}`),o.onended=l,o.onerror=l,await o.play();return}}catch{}u()})()})}});