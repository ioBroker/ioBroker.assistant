import{useState as e,createRoot as t,jsx as n,jsxs as r}from"../../../lib/esm/react-19.js";var i=`iob-dialog-close`;function a(e){return!!e.form}var o=[`header`,`staticText`,`divider`];function s(e,t){return e==null?``:typeof e==`object`?e[t]||e.en||Object.values(e).find(e=>!!e)||``:String(e)}function c(e){let t={};for(let[n,r]of Object.entries(e.items||{}))r&&!o.includes(r.type)&&(t[n]=r.type);return t}function l(e){return typeof e==`string`?e:typeof e==`number`||typeof e==`boolean`?e.toString():JSON.stringify(e)}function u(e,t){if(t!=null)switch(e){case`number`:case`slider`:{if(typeof t==`number`)return Number.isFinite(t)?t:void 0;let e=l(t).trim().replace(`,`,`.`);if(!e)return;let n=Number(e);return Number.isFinite(n)?n:void 0}case`checkbox`:return t===!0||t===`true`||t===1||t===`1`;default:return l(t)}}function d(e,t){let n={};for(let[r,i]of Object.entries(e)){let e=u(i,t[r]);e!==void 0&&(n[r]=e)}return n}var f=`"Roboto", "Helvetica", "Arial", sans-serif`,p=Object.freeze({type:`light`,primary:`#3399CC`,primaryContrast:`#FFFFFF`,secondary:`#164477`,secondaryContrast:`#FFFFFF`,background:`#FFFFFF`,paper:`#FFFFFF`,text:`rgba(0, 0, 0, 0.87)`,textSecondary:`rgba(0, 0, 0, 0.6)`,divider:`rgba(0, 0, 0, 0.12)`,error:`#D32F2F`,warning:`#ED6C02`,info:`#0288D1`,success:`#2E7D32`,fontFamily:f,fontSize:14,borderRadius:4}),m=Object.freeze({type:`dark`,primary:`#4DABF5`,primaryContrast:`rgba(0, 0, 0, 0.87)`,secondary:`#436A93`,secondaryContrast:`#FFFFFF`,background:`#121212`,paper:`#121212`,text:`#FFFFFF`,textSecondary:`rgba(255, 255, 255, 0.7)`,divider:`rgba(255, 255, 255, 0.12)`,error:`#F44336`,warning:`#FFA726`,info:`#29B6F6`,success:`#66BB6A`,fontFamily:f,fontSize:14,borderRadius:4}),h=[`primary`,`primaryContrast`,`secondary`,`secondaryContrast`,`background`,`paper`,`text`,`textSecondary`,`divider`,`error`,`warning`,`info`,`success`,`fontFamily`],g=[`fontSize`,`borderRadius`];function _(e){return{...e===`dark`?m:p}}function v(e){if(!e||typeof e!=`object`)return _(typeof e==`string`?e:`light`);let t=e,n=_(typeof t.type==`string`?t.type:`light`);for(let e of h){let r=t[e];typeof r==`string`&&r.trim()&&(n[e]=r.trim())}for(let e of g){let r=t[e],i=typeof r==`string`?parseFloat(r):r;typeof i==`number`&&Number.isFinite(i)&&i>=0&&(n[e]=i)}return n}function y(e,t){return e.type===t.type&&h.every(n=>e[n]===t[n])&&g.every(n=>e[n]===t[n])}function b(e){return`--iob-${e.replace(/[A-Z]/g,e=>`-${e.toLowerCase()}`)}`}function x(e){let t={};for(let n of h)t[b(n)]=e[n];for(let n of g)t[b(n)]=`${e[n]}px`;return t[`color-scheme`]=e.type,t}var S={ok:{en:`OK`,"zh-cn":`确定`},cancel:{en:`Cancel`,de:`Abbrechen`,ru:`Отмена`,pt:`Cancelar`,nl:`Annuleren`,fr:`Annuler`,it:`Annulla`,es:`Cancelar`,pl:`Anuluj`,uk:`Скасувати`,"zh-cn":`取消`},close:{en:`Close`,de:`Schließen`,ru:`Закрыть`,pt:`Fechar`,nl:`Sluiten`,fr:`Fermer`,it:`Chiudi`,es:`Cerrar`,pl:`Zamknij`,uk:`Закрити`,"zh-cn":`关闭`}},C=`
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
`;function w(e){if(!e)return null;try{let t=Function(`data`,`return (${e});`);return e=>{try{return!!t(e)}catch{return!1}}}catch{return null}}function T(e){return typeof e==`string`?e:typeof e==`number`||typeof e==`boolean`?String(e):``}function E(e){let{input:t,setting:n}=e;if(t)return t instanceof HTMLInputElement&&t.type===`checkbox`?t.checked:t instanceof HTMLSelectElement?n.options?.[t.selectedIndex]?.value:t.value}function D(e,t,n,r,i){let a={name:t,setting:n,box:e.createElement(`div`),hidden:w(n.hidden),disabled:w(n.disabled)},o=s(n.label,i);switch(n.type){case`header`:return a.box=e.createElement(`h3`),a.box.textContent=s(n.text,i)||o,a;case`staticText`:return a.box=e.createElement(`p`),a.box.textContent=s(n.text,i)||o,a;case`divider`:return a.box=e.createElement(`hr`),a}let c=e.createElement(`label`);a.box=c;let l=e.createElement(`span`);if(l.textContent=o||t,n.type===`checkbox`){let t=e.createElement(`input`);t.type=`checkbox`,t.checked=r===!0||r===`true`,c.className=`check`,c.append(t,l),a.input=t}else if(n.type===`select`){let t=e.createElement(`select`);for(let r of n.options||[]){let n=e.createElement(`option`);n.textContent=s(r.label,i),t.append(n)}let o=(n.options||[]).findIndex(e=>String(e.value)===T(r));t.selectedIndex=o===-1?0:o,c.append(l,t),a.input=t}else if(n.type===`text`&&(n.minRows||1)>1){let t=e.createElement(`textarea`);t.rows=n.minRows||2,t.value=T(r),c.append(l,t),a.input=t}else{let t=e.createElement(`input`),i=T(r);switch(n.type){case`number`:case`slider`:t.type=n.type===`slider`?`range`:`number`,n.min!==void 0&&(t.min=String(n.min)),n.max!==void 0&&(t.max=String(n.max)),t.step=n.step===void 0?`any`:String(n.step);break;case`password`:t.type=`password`;break;case`color`:t.type=!i||/^#[0-9a-f]{6}$/i.test(i)?`color`:`text`;break;default:t.type=`text`}if(t.value=i,t.type===`range`){let n=e.createElement(`output`);n.textContent=t.value,t.addEventListener(`input`,()=>n.textContent=t.value),l.append(`: `,n)}c.append(l,t),a.input=t}if(n.help){let t=e.createElement(`span`);t.className=`help`,t.textContent=s(n.help,i),c.append(t)}return a}function O(e,t={}){let n=t.lang||`en`,r=document,o=e=>S[e][n]||S[e].en||e,l=r.createElement(`div`);l.setAttribute(`data-iob-dialog`,``);let u=l.attachShadow({mode:`open`}),f=r.createElement(`style`);f.textContent=C;let p=r.createElement(`dialog`),m=v(t.theme);p.className=m.type===`dark`?`dark`:``;for(let[e,t]of Object.entries(x(m)))p.style.setProperty(e,t);e.width&&(p.style.width=`${e.width}px`),e.height&&(p.style.height=`${e.height}px`);let h=r.createElement(`form`),g=r.createElement(`header`),_=r.createElement(`span`);_.textContent=s(e.title,n);let y=r.createElement(`button`);y.type=`button`,y.className=`close`,y.title=o(`close`),y.setAttribute(`aria-label`,o(`close`)),y.textContent=`×`,g.append(_,y);let b=r.createElement(`div`);return b.className=`body`,h.append(g,b),p.append(h),u.append(f,p),new Promise(t=>{let f=!1,m=e=>{f||(f=!0,p.open&&p.close(),l.remove(),t(e))};if(y.addEventListener(`click`,()=>m(null)),p.addEventListener(`close`,()=>m(null)),h.addEventListener(`submit`,e=>e.preventDefault()),a(e)){let t={},i=[];for(let[t,a]of Object.entries(e.form.items||{})){let o=e.data?.[t]??a.default,s=D(r,t,a,o,n);i.push(s),b.append(s.box)}let a=()=>{for(let e of i)e.input&&(t[e.name]=E(e));return t},l=()=>{let e=a();for(let t of i)t.box.hidden=t.hidden?t.hidden(e):!1,t.input&&(t.input.disabled=t.disabled?t.disabled(e):!1)};h.addEventListener(`input`,l),h.addEventListener(`change`,l),l();let u=i.find(e=>e.input&&!e.box.hidden&&!e.input.disabled);u?.input&&(u.input.autofocus=!0);let f=r.createElement(`footer`),p=r.createElement(`button`);p.type=`button`,p.textContent=s(e.cancel,n)||o(`cancel`),p.addEventListener(`click`,()=>m(null));let g=r.createElement(`button`);g.type=`submit`,g.className=`primary`,g.textContent=s(e.ok,n)||o(`ok`),f.append(p,g),h.append(f),h.addEventListener(`submit`,()=>m(d(c(e.form),a())))}else b.append(e.element),p.addEventListener(i,e=>m(e.detail??null));r.body.append(l),p.showModal(),u.activeElement&&u.activeElement!==y||(p.tabIndex=-1,p.focus())})}function k(e){return[...new Set(e.filter(e=>typeof e==`string`&&!!e))]}var A=[`socket`,`dialogs`,`theme`,`editMode`,`settings`,`value`],j=class extends HTMLElement{states={};objects={};#e=null;#t={};#n=v(`light`);#r=!1;#i=null;#a=void 0;#o=null;#s=!1;#c=(e,t)=>{this.#o?.states.includes(e)&&(this.states[e]=t||null,this.#_())};#l=(e,t)=>{this.#o?.objects.includes(e)&&(this.objects[e]=t||null,this.#d())};get socket(){return this.#e}set socket(e){this.#e=e||null,this.#d()}get settings(){return this.#t}set settings(e){this.#t=e||{},this.#d()}get theme(){return this.#n}set theme(e){let t=v(e);y(t,this.#n)||(this.#n=t,this.#u(),this.#_())}get editMode(){return this.#r}set editMode(e){let t=!!e;t!==this.#r&&(this.#r=t,this.#_())}get dialogs(){return this.#i}set dialogs(e){this.#i=e||null}get value(){return this.#a}set value(e){e!==this.#a&&(this.#a=e,this.#_())}connectedCallback(){for(let e of A)if(Object.prototype.hasOwnProperty.call(this,e)){let t=this[e];delete this[e],this[e]=t}this.#u(),this.#d()}disconnectedCallback(){this.#g()}getStateIds(e){return[]}getObjectIds(e){return[]}get systemLang(){return this.#e?.systemLang||`en`}text(e){return s(e,this.systemLang)}setState(e,t){return this.#e&&!this.#r?this.#e.setState(e,t):Promise.resolve()}changeValue(e){return this.#r||this.emit(`iob-change`,e)?!1:(this.value=e,!0)}emit(e,t){return this.dispatchEvent(new CustomEvent(e,{detail:t,bubbles:!0,composed:!0,cancelable:!0}))}async openDialog(e){if(this.#r)return null;let t=this.#i?await this.#i.open(e):await O(e,{lang:this.systemLang,theme:this.#n});return a(e)?t&&typeof t==`object`?d(c(e.form),t):null:t??null}#u(){for(let[e,t]of Object.entries(x(this.#n)))this.style.setProperty(e,t)}#d(){if(!this.isConnected)return;let e=this.#e,t=e?k(this.getStateIds(this.#t)):[],n=e?k(this.getObjectIds(this.#t)):[];this.#o&&this.#o.socket!==e&&this.#g();let r=this.#o?.states||[],i=this.#o?.objects||[],a=r.filter(e=>!t.includes(e)),o=i.filter(e=>!n.includes(e)),s=t.filter(e=>!r.includes(e)),c=n.filter(e=>!i.includes(e));e&&a.length&&e.unsubscribeState(a,this.#c),e&&o.length&&this.#h(e,o);for(let e of a)delete this.states[e];for(let e of[...a,...o])!t.includes(e)&&!n.includes(e)&&delete this.objects[e];this.#o=e&&(t.length||n.length)?{socket:e,states:t,objects:n}:null,e&&s.length&&this.#p(e,s),e&&c.length&&this.#m(e,c),this.#_()}#f(e,t,n){return this.#o?.socket===e&&this.#o[t].includes(n)}#p(e,t){e.subscribeState(t,this.#c).catch(e=>console.warn(`<${this.localName}>: cannot subscribe ${t.join(`, `)}: ${e}`));for(let n of t)e.getState(n).then(t=>{this.#f(e,`states`,n)&&this.states[n]===void 0&&(this.states[n]=t||null,this.#_())}).catch(()=>{}),e.getObject(n).then(t=>{this.#f(e,`states`,n)&&!this.#f(e,`objects`,n)&&(this.objects[n]=t||null,this.#_())}).catch(()=>{})}#m(e,t){e.subscribeObject(t,this.#l).catch(e=>console.warn(`<${this.localName}>: cannot subscribe the objects ${t.join(`, `)}: ${e}`));for(let n of t)e.getObject(n).then(t=>{this.#f(e,`objects`,n)&&(this.objects[n]=t||null,this.#d())}).catch(()=>{})}#h(e,t){e.unsubscribeObject(t,this.#l).catch(()=>{})}#g(){if(this.#o){let{socket:e,states:t,objects:n}=this.#o;t.length&&e.unsubscribeState(t,this.#c),n.length&&this.#h(e,n),this.#o=null}this.states={},this.objects={}}#_(){this.#s||(this.#s=!0,queueMicrotask(()=>{this.#s=!1,this.isConnected&&this.render()}))}};function M(e,t){let n=typeof e==`string`?e:e.tag;customElements.get(n)||customElements.define(n,t)}var N=`iob-assistant-satellites`;function P(e){let t=(e||``).trim().replace(/^system\.adapter\./,``);return/^assistant\.\d+$/.test(t)?t:``}var F={en:{"Last seen":`Last seen`,Announcement:`Announcement`,"Send announcement":`Send announcement`,"Speak on all satellites":`Speak on all satellites`,"No satellites registered yet.":`No satellites registered yet.`},de:{"Last seen":`Zuletzt gesehen`,Announcement:`Ansage`,"Send announcement":`Ansage senden`,"Speak on all satellites":`Auf allen Satelliten ansagen`,"No satellites registered yet.":`Noch keine Satelliten registriert.`},ru:{"Last seen":`Последний раз видели`,Announcement:`Объявление`,"Send announcement":`Отправить объявление`,"Speak on all satellites":`Выступить на всех спутниках`,"No satellites registered yet.":`Спутники пока не зарегистрированы.`},pt:{"Last seen":`Última vez visto`,Announcement:`Anúncio`,"Send announcement":`Enviar anúncio`,"Speak on all satellites":`Fale em todos os satélites`,"No satellites registered yet.":`Nenhum satélite registrado ainda.`},nl:{"Last seen":`Laatst gezien`,Announcement:`Aankondiging`,"Send announcement":`Aankondiging verzenden`,"Speak on all satellites":`Communiceer via alle satellieten`,"No satellites registered yet.":`Er zijn nog geen satellieten geregistreerd.`},fr:{"Last seen":`Dernière observation`,Announcement:`Annonce`,"Send announcement":`Envoyer l'annonce`,"Speak on all satellites":`Parlez sur tous les satellites`,"No satellites registered yet.":`Aucun satellite enregistré pour le moment.`},it:{"Last seen":`Ultimo avvistamento`,Announcement:`Annuncio`,"Send announcement":`Invia annuncio`,"Speak on all satellites":`Comunicare su tutti i satelliti`,"No satellites registered yet.":`Nessun satellite ancora registrato.`},es:{"Last seen":`Última vez visto`,Announcement:`Anuncio`,"Send announcement":`Enviar anuncio`,"Speak on all satellites":`Hablar por todos los satélites`,"No satellites registered yet.":`Aún no se han registrado satélites.`},pl:{"Last seen":`Ostatnio widziany`,Announcement:`Ogłoszenie`,"Send announcement":`Wyślij ogłoszenie`,"Speak on all satellites":`Mów na wszystkich satelitach`,"No satellites registered yet.":`Nie zarejestrowano jeszcze żadnych satelitów.`},uk:{"Last seen":`Бачили востаннє`,Announcement:`Оголошення`,"Send announcement":`Надіслати оголошення`,"Speak on all satellites":`Розмовляйте на всіх супутниках`,"No satellites registered yet.":`Поки що не зареєстровано жодного супутника.`},"zh-cn":{"Last seen":`最后一次出现`,Announcement:`公告`,"Send announcement":`发送公告`,"Speak on all satellites":`在所有卫星上通话`,"No satellites registered yet.":`目前尚未注册任何卫星。`}},I={en:{chooseInstance:`Choose an instance of the assistant in the settings`},de:{chooseInstance:`Instanz des Assistenten in den Einstellungen wählen`},ru:{chooseInstance:`Выберите экземпляр ассистента в настройках`},pt:{chooseInstance:`Escolha uma instância do assistente nas configurações`},nl:{chooseInstance:`Kies een instantie van de assistent in de instellingen`},fr:{chooseInstance:`Choisissez une instance de l'assistant dans les paramètres`},it:{chooseInstance:`Scegli un'istanza dell'assistente nelle impostazioni`},es:{chooseInstance:`Elija una instancia del asistente en la configuración`},pl:{chooseInstance:`Wybierz instancję asystenta w ustawieniach`},uk:{chooseInstance:`Виберіть екземпляр асистента в налаштуваннях`},"zh-cn":{chooseInstance:`请在设置中选择助手实例`}};function L(e,t){return n=>r=>r in e.en?e[n]?.[r]||e.en[r]:r===`chooseInstance`?I[n]?.chooseInstance||I.en.chooseInstance:t.includes(r)&&(F[n]?.[r]||F.en?.[r])||r}function R(e){return{de:`de-DE`,en:`en-US`,ru:`ru-RU`,pt:`pt-PT`,nl:`nl-NL`,fr:`fr-FR`,it:`it-IT`,es:`es-ES`,pl:`pl-PL`,uk:`uk-UA`,"zh-cn":`zh-CN`}[e]||e||`en-US`}var z=L({en:{online:`online`,offline:`offline`,status_idle:`idle`,status_listening:`listening`,status_processing:`processing`,status_speaking:`speaking`,whatToSay:`What to say`},de:{online:`online`,offline:`offline`,status_idle:`bereit`,status_listening:`hört zu`,status_processing:`verarbeitet`,status_speaking:`spricht`,whatToSay:`Was gesagt werden soll`},ru:{online:`в сети`,offline:`не в сети`,status_idle:`ожидание`,status_listening:`слушает`,status_processing:`обработка`,status_speaking:`говорит`,whatToSay:`Что сказать`},pt:{online:`online`,offline:`offline`,status_idle:`em espera`,status_listening:`a ouvir`,status_processing:`a processar`,status_speaking:`a falar`,whatToSay:`O que dizer`},nl:{online:`online`,offline:`offline`,status_idle:`inactief`,status_listening:`luistert`,status_processing:`verwerkt`,status_speaking:`spreekt`,whatToSay:`Wat er gezegd moet worden`},fr:{online:`en ligne`,offline:`hors ligne`,status_idle:`en attente`,status_listening:`écoute`,status_processing:`traitement`,status_speaking:`parle`,whatToSay:`Ce qu’il faut dire`},it:{online:`online`,offline:`offline`,status_idle:`inattivo`,status_listening:`in ascolto`,status_processing:`elaborazione`,status_speaking:`parla`,whatToSay:`Cosa dire`},es:{online:`en línea`,offline:`sin conexión`,status_idle:`en espera`,status_listening:`escuchando`,status_processing:`procesando`,status_speaking:`hablando`,whatToSay:`Qué decir`},pl:{online:`online`,offline:`offline`,status_idle:`bezczynny`,status_listening:`słucha`,status_processing:`przetwarza`,status_speaking:`mówi`,whatToSay:`Co powiedzieć`},uk:{online:`у мережі`,offline:`не в мережі`,status_idle:`очікування`,status_listening:`слухає`,status_processing:`обробка`,status_speaking:`говорить`,whatToSay:`Що сказати`},"zh-cn":{online:`在线`,offline:`离线`,status_idle:`空闲`,status_listening:`聆听中`,status_processing:`处理中`,status_speaking:`播报中`,whatToSay:`播报内容`}},[`Last seen`,`Announcement`,`Send announcement`,`Speak on all satellites`,`No satellites registered yet.`]),B={chat:`M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2M6 9h12v2H6zm8 5H6v-2h8zm4-6H6V6h12z`,speaker:`M17 2H7c-1.1 0-2 .9-2 2v16c0 1.1.9 1.99 2 1.99L17 22c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2m-5 2c1.1 0 2 .9 2 2s-.9 2-2 2c-1.11 0-2-.9-2-2s.89-2 2-2m0 16c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5m0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3`,send:`M2.01 21 23 12 2.01 3 2 10l15 2-15 2z`,mic:`M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3m5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72z`,dialog:`M9 13c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4m0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4m6.08-7.95c.84 1.18.84 2.71 0 3.89l1.68 1.69c2.02-2.02 2.02-5.07 0-7.27zM20.07 2l-1.63 1.63c2.77 3.02 2.77 7.56 0 10.74L20.07 16c3.9-3.89 3.91-9.95 0-14`,volumeOn:`M3 9v6h4l5 5V4L7 9zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02M14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77`,volumeOff:`M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63m2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71M4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9zM12 4 9.91 6.09 12 8.18z`,announce:`M18 11v2h4v-2zm-2 6.61c.96.71 2.21 1.65 3.2 2.39.4-.53.8-1.07 1.2-1.6-.99-.74-2.24-1.68-3.2-2.4-.4.54-.8 1.08-1.2 1.61M20.4 5.6c-.4-.53-.8-1.07-1.2-1.6-.99.74-2.24 1.68-3.2 2.4.4.53.8 1.07 1.2 1.6.96-.72 2.21-1.65 3.2-2.4M4 9c-1.1 0-2 .9-2 2v2c0 1.1.9 2 2 2h1v4h2v-4h1l5 3V6L8 9zm11.5 3c0-1.33-.58-2.53-1.5-3.35v6.69c.92-.81 1.5-2.01 1.5-3.34`};function V({path:e}){return/* @__PURE__ */ n(`svg`,{viewBox:`0 0 24 24`,"aria-hidden":`true`,children:/* @__PURE__ */ n(`path`,{d:e})})}function H({text:e,icon:t,editMode:i}){return/* @__PURE__ */ r(`div`,{className:`hint${i?` edit`:``}`,children:[/* @__PURE__ */ n(V,{path:t}),/* @__PURE__ */ n(`span`,{children:e})]})}var U=`
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

.satellites {
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    padding: 6px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    overflow: hidden;
}
.list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    display: flex;
    flex-direction: column;
}
.empty {
    margin: auto;
    padding: 16px;
    text-align: center;
    color: var(--iob-text-secondary);
}
.sat {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 44px;
    padding: 4px 4px 4px 8px;
    border-bottom: 1px solid var(--iob-divider);
}
.sat:last-child {
    border-bottom: none;
}
.dot {
    flex: none;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--iob-error);
}
.dot.alive {
    background: var(--iob-success);
}
.info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
}
.name {
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.sub {
    font-size: 0.8em;
    color: var(--iob-text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.status {
    --state: var(--iob-text-secondary);
    flex: none;
    padding: 1px 9px;
    border: 1px solid var(--state);
    border-radius: 999px;
    color: var(--state);
    font-size: 0.78em;
    line-height: 1.5;
    white-space: nowrap;
}
.status.listening {
    --state: var(--iob-info);
}
.status.processing {
    --state: var(--iob-warning);
}
.status.speaking {
    --state: var(--iob-success);
}
.status.offline {
    --state: var(--iob-error);
}
.seen {
    flex: none;
    width: 6.5em;
    text-align: right;
    font-size: 0.8em;
    color: var(--iob-text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.composer {
    flex: none;
    display: flex;
    align-items: center;
    gap: 4px;
}
@container (max-width: 340px) {
    .seen {
        display: none;
    }
}
@container (max-width: 240px) {
    .status {
        display: none;
    }
}
`,W=[`status`,`room`,`host`,`alive`,`lastSeen`],G=3e4,K=10,q={idle:`status_idle`,listening:`status_listening`,processing:`status_processing`,speaking:`status_speaking`,offline:`offline`};function J(e){return[...new Set(e)].sort().join(`
`)}function Y(e,t,n){if(!e)return`—`;let r=Math.round((e-t)/1e3),i=Math.abs(r),a=r,o=`second`;i>=86400?(a=Math.round(r/86400),o=`day`):i>=3600?(a=Math.round(r/3600),o=`hour`):i>=60&&(a=Math.round(r/60),o=`minute`);try{return new Intl.RelativeTimeFormat(n,{numeric:`auto`,style:`short`}).format(a,o)}catch{return new Date(e).toLocaleString()}}function X(t){let{satellites:i,word:a,editMode:o}=t,[s,c]=e(``),l=()=>{let e=s.trim();e&&!o&&(t.onAnnounceAll(e),c(``))};return/* @__PURE__ */ r(`div`,{className:`satellites${o?` edit`:``}`,children:[/* @__PURE__ */ n(`div`,{className:`list`,children:i===null?null:i.length?i.map(e=>{let i=[e.room&&e.room!==e.name?e.room:``,t.showHost?e.host:``].filter(Boolean).join(` · `),s=q[e.status];return/* @__PURE__ */ r(`div`,{className:`sat`,children:[/* @__PURE__ */ n(`span`,{className:`dot${e.alive?` alive`:``}`,title:a(e.alive?`online`:`offline`)}),/* @__PURE__ */ r(`div`,{className:`info`,children:[/* @__PURE__ */ n(`span`,{className:`name`,title:e.id,children:e.name}),i?/* @__PURE__ */ n(`span`,{className:`sub`,children:i}):null]}),/* @__PURE__ */ n(`span`,{className:`status ${e.status}`,children:s?a(s):e.status}),/* @__PURE__ */ n(`span`,{className:`seen`,title:e.lastSeen?`${a(`Last seen`)}: ${new Date(e.lastSeen).toLocaleString(t.locale)}`:a(`Last seen`),children:Y(e.lastSeen,t.now,t.locale)}),t.announce?/* @__PURE__ */ n(`button`,{type:`button`,className:`icon-btn primary`,title:a(`Send announcement`),"aria-label":a(`Send announcement`),disabled:o,onClick:()=>t.onAnnounce(e),children:/* @__PURE__ */ n(V,{path:B.announce})}):null]},e.id)}):/* @__PURE__ */ n(`div`,{className:`empty`,children:a(`No satellites registered yet.`)})}),t.announce&&i?.length?/* @__PURE__ */ r(`div`,{className:`composer`,children:[/* @__PURE__ */ n(`input`,{className:`field`,type:`text`,value:s,placeholder:a(`Speak on all satellites`),disabled:o,onChange:e=>c(e.target.value),onKeyDown:e=>{e.key===`Enter`&&(e.preventDefault(),l())}}),/* @__PURE__ */ n(`button`,{type:`button`,className:`icon-btn filled`,title:a(`Speak on all satellites`),"aria-label":a(`Speak on all satellites`),disabled:o||!s.trim(),onClick:l,children:/* @__PURE__ */ n(V,{path:B.announce})})]}):null]})}M(N,class extends j{#e;#t=null;#n=``;#r=null;#i=``;#a=null;#o=0;constructor(){super();let e=this.attachShadow({mode:`open`}),n=document.createElement(`style`);n.textContent=U;let r=document.createElement(`div`);r.className=`mount`,e.append(n,r),this.#e=t(r)}connectedCallback(){super.connectedCallback(),this.#a||=setInterval(()=>this.#c(),G)}disconnectedCallback(){super.disconnectedCallback(),this.#a&&=(clearInterval(this.#a),null)}getStateIds(e){let t=this.#s(e);return this.#i=J(t),t}#s(e){let t=P(e.instance);return!t||t!==this.#n||!this.#t?[]:[...this.#t.keys()].flatMap(e=>W.map(n=>`${t}.satellites.${e}.${n}`))}#c(){++this.#o%K===0&&(this.#r=null),this.isConnected&&this.render()}#l(e){let t=this.socket;if(!t||e===this.#n&&t===this.#r)return;e!==this.#n&&(this.#t=null),this.#n=e,this.#r=t;let n=`${e}.satellites.`;t.getObjectViewSystem(`device`,n,`${n}香`).then(e=>{let t=this.systemLang,r=/* @__PURE__ */ new Map;for(let[i,a]of Object.entries(e||{})){let e=i.slice(n.length);if(!e||e.includes(`.`))continue;let o=a?.common?.name,s=typeof o==`string`?o:o&&(o[t]||o.en)||``;r.set(e,s||e)}return r}).catch(t=>(console.warn(`<${this.localName}>: cannot read the satellites of ${e}: ${String(t)}`),this.#t||/* @__PURE__ */ new Map)).then(n=>{e===this.#n&&t===this.#r&&(this.#t=n,this.#u())}).catch(()=>void 0)}#u(){let e=this.settings;this.settings=e}#d(e){if(!this.#t||e!==this.#n)return null;let t=(t,n)=>this.states[`${e}.satellites.${t}.${n}`]?.val;return[...this.#t.entries()].map(([e,n])=>({id:e,name:n,status:String(t(e,`status`)??`idle`),room:String(t(e,`room`)??``),host:String(t(e,`host`)??``),alive:!!t(e,`alive`),lastSeen:Number(t(e,`lastSeen`))||0})).sort((e,t)=>e.name.localeCompare(t.name,void 0,{numeric:!0})||e.id.localeCompare(t.id))}async#f(e,t,n){if(this.editMode)return;let r=await this.openDialog({title:`${n(`Announcement`)} · ${t.name}`,form:{type:`panel`,items:{text:{type:`text`,label:n(`whatToSay`)}}},data:{text:``},ok:n(`Send announcement`)}),i=typeof r?.text==`string`?r.text.trim():``;i&&await this.setState(`${e}.satellites.${t.id}.tts`,i).catch(()=>void 0)}render(){let e=P(this.settings.instance),t=this.systemLang,r=z(t);e?(this.#l(e),this.socket&&J(this.#s(this.settings))!==this.#i?this.#u():this.#e.render(/* @__PURE__ */ n(X,{satellites:this.#d(e),announce:this.settings.announce!==!1,showHost:!!this.settings.showHost,editMode:this.editMode,now:Date.now(),locale:R(t),word:r,onAnnounce:t=>void this.#f(e,t,r),onAnnounceAll:t=>void this.setState(`${e}.tts.text`,t).catch(()=>void 0)}))):this.#e.render(/* @__PURE__ */ n(H,{text:r(`chooseInstance`),icon:B.speaker,editMode:this.editMode}))}});