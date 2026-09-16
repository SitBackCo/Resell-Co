// Resell & Co service worker — network-first shell, offline fallback
var CACHE='resellco-2026-09-15.3';
var ASSETS=['./index.html','./manifest.json','./apple-touch-icon.png','./icon-192.png','./icon-512.png'];
self.addEventListener('install',function(e){ e.waitUntil(caches.open(CACHE).then(function(c){return c.addAll(ASSETS);}).then(function(){return self.skipWaiting();})); });
self.addEventListener('activate',function(e){ e.waitUntil(caches.keys().then(function(keys){return Promise.all(keys.filter(function(k){return k!==CACHE;}).map(function(k){return caches.delete(k);}));}).then(function(){return self.clients.claim();})); });
self.addEventListener('fetch',function(e){
  var url=e.request.url;
  if(e.request.method!=='GET') return;
  if(/firebase|googleapis|gstatic|workers\.dev/.test(url)) return; // never intercept data/API
  var isShell = e.request.mode==='navigate' || /index\.html$|\/$/.test(url);
  if(isShell){
    e.respondWith(fetch(e.request).then(function(r){ var cp=r.clone(); caches.open(CACHE).then(function(c){c.put(e.request,cp);}); return r; })
      .catch(function(){ return caches.match(e.request).then(function(m){ return m||caches.match('./index.html'); }); }));
    return;
  }
  e.respondWith(caches.match(e.request).then(function(m){ return m||fetch(e.request).then(function(r){ if(r.ok&&/fonts\.|\.png$|manifest/.test(url)){ var cp=r.clone(); caches.open(CACHE).then(function(c){c.put(e.request,cp);}); } return r; }); }));
});

/* ── Web Push: notifications arrive even when the app is closed ── */
self.addEventListener('push',function(e){
  var data={title:'Resell & Co',body:'',url:'./',tag:'rc'};
  try{ var j=e.data?e.data.json():null; if(j) data=Object.assign(data,j); }catch(err){ try{ data.body=e.data?e.data.text():''; }catch(_){} }
  var opts={ body:data.body, icon:'./icon-192.png', badge:'./icon-192.png', tag:data.tag, renotify:true,
    requireInteraction:!!data.sticky, data:{url:data.url||'./'}, vibrate:data.hot?[80,40,80,40,160]:[60] };
  e.waitUntil(self.registration.showNotification(data.title,opts));
});
self.addEventListener('notificationclick',function(e){
  e.notification.close();
  var url=(e.notification.data&&e.notification.data.url)||'./';
  e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(function(cs){
    for(var i=0;i<cs.length;i++){ if('focus' in cs[i]){ cs[i].focus(); if(url && url!=='./') cs[i].postMessage({type:'open',url:url}); return; } }
    return self.clients.openWindow(url.indexOf('http')===0?url:'./');
  }));
});
