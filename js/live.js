/* ORBITAL · capa "en vivo": toma los datos reales del backend (OrbitalAPI) y los deja en la MISMA
   forma que usa el prototipo (series, sueño, cognición, banda personal), para no reescribir las vistas.
   Puro: no toca React ni el DOM. El cableado (setState, SSE) vive en index.html.
   Si el backend no responde, el prototipo sigue en modo demostración con sus datos sintéticos.
   Expone window.OrbitalLive. */
(function () {
  'use strict';
  var A = window.OrbitalAPI;

  // Identidad de diseño -> id del backend. Carlos no está en el backend (tarjeta "sin sensor").
  var BACKEND_ID = { katya: 'astro_1', jose: 'astro_2', rodolfo: 'astro_3' };
  var VITALES = ['pulso', 'spo2', 'presion_sistolica', 'presion_diastolica'];

  function mean(a) { return a.reduce(function (x, y) { return x + y; }, 0) / a.length; }
  function sd(a) { if (a.length < 2) return 0; var m = mean(a); return Math.sqrt(mean(a.map(function (x) { return (x - m) * (x - m); }))); }

  // Serie {var:[valores]} a partir del historial del backend ([{timestamp, valores}]).
  function seriesDeHistorial(historial) {
    var out = {}; VITALES.forEach(function (k) { out[k] = []; });
    (historial || []).forEach(function (h) { VITALES.forEach(function (k) { if (h.valores && h.valores[k] != null) out[k].push(h.valores[k]); }); });
    return out;
  }

  // Banda personal [lo, hi, base, sd]: usa el rango esperado del backend si existe; si no (modelo sin entrenar), lo calcula de la serie.
  function bandaDe(serie, resumenMedida) {
    var vals = serie.filter(function (v) { return v != null; });
    var base = vals.length ? mean(vals) : 0, s = Math.max(sd(vals), 0.5);
    if (resumenMedida && resumenMedida.esperado_personal && resumenMedida.esperado_personal.lower != null) {
      var ep = resumenMedida.esperado_personal;
      return [ep.lower, ep.upper, ep.valor != null ? ep.valor : base, Math.max((ep.upper - ep.lower) / 4, 0.5)];
    }
    if (resumenMedida && resumenMedida.linea_base != null) base = resumenMedida.linea_base;
    return [base - 2 * s, base + 2 * s, base, s];
  }

  // Noches de sueño del backend -> {dur:[],eff:[],lat:[]} (en orden, más antigua primero).
  function sleepDeNoches(noches) {
    if (!noches || !noches.length) return null;
    var dur = [], eff = [], lat = [], meds = [];
    noches.forEach(function (n) {
      var v = n.valores || {};
      if (v.sueno_duracion != null) dur.push(v.sueno_duracion);
      if (v.sueno_eficiencia != null) eff.push(v.sueno_eficiencia);
      if (v.sueno_latencia != null) lat.push(v.sueno_latencia);
      meds.push(n.medicacion || null);
    });
    if (!dur.length) return null;
    return { dur: dur, eff: eff, lat: lat, meds: meds };
  }

  // Sesiones cognitivas del backend -> arrays por prueba para la vista (valores crudos comparables).
  function cogDeSesiones(sesiones) {
    var out = { pvt: [], dsst: [], matrix: [] };
    (sesiones || []).forEach(function (s) {
      var p = s.pruebas || {};
      if (p.pvt && p.pvt.rt_mediana_ms != null) out.pvt.push(p.pvt.rt_mediana_ms);
      if (p.dsst && p.dsst.correctas != null) out.dsst.push(p.dsst.correctas);
      if (p.matrix && p.matrix.correctas != null) out.matrix.push(p.matrix.correctas);
    });
    return out;
  }

  window.OrbitalLive = {
    BACKEND_ID: BACKEND_ID,
    VITALES: VITALES,

    // ¿Está el backend disponible? Devuelve el objeto /salud o null.
    detectar: function () { return A.ping(2500); },

    /* Enriquece el arreglo de tripulantes de diseño con datos reales del backend.
       Mantiene identidad (name, role, task, order, seed, temp) y reemplaza series/band/sleep/cog por lo real.
       Para los que no están en el backend (Carlos) conserva su estado sintético (noData o demo).
       Devuelve {crew, backendIds, aptitud, cogEstado} o lanza si falla la carga de los reales. */
    cargarCrew: async function (designCrew) {
      var lista = await A.tripulantes();                 // [{id, variables, lecturas_disponibles, noches_disponibles}]
      var porId = {}; lista.forEach(function (t) { porId[t.id] = t; });
      var aptitud = {}, cogEstado = {};

      var crew = await Promise.all(designCrew.map(async function (base) {
        var bid = BACKEND_ID[base.id];
        if (!bid || !porId[bid]) return Object.assign({}, base);   // Carlos u otros: queda como está (demo/sin sensor)

        var salud = await A.saludTripulante(bid, 200);              // historial + sueño actuales
        var serie = seriesDeHistorial(salud.historial);
        var sleep = sleepDeNoches(salud.sueno);

        var resumen = null, band = {};
        try { resumen = await A.resumen(bid); } catch (e) { resumen = null; }
        var med = (resumen && resumen.medidas) || {};
        VITALES.forEach(function (k) { if (serie[k] && serie[k].length) band[k] = bandaDe(serie[k], med[k]); });

        var cog = { pvt: [], dsst: [], matrix: [] };
        try { var ch = await A.cognitivo(bid); cog = cogDeSesiones(ch.sesiones); } catch (e) { }
        try { var cr = await A.cognitivoResumen(bid); cogEstado[base.id] = { estado: cr.estado, codigo: cr.codigo_nivel, completa: cr.linea_base_completa, validas: cr.sesiones_validas, base: cr.sesiones_linea_base }; } catch (e) { }
        try { aptitud[base.id] = await A.aptitud(bid); } catch (e) { }

        // "days" (histórico largo) no existe en el backend (solo 1 día): se deja el sintético del diseño, etiquetado como demo en la UI.
        return Object.assign({}, base, {
          backendId: bid, live: true, noData: false,
          series: Object.assign({}, base.series || {}, serie),
          band: Object.assign({}, base.band || {}, band),
          sleep: sleep,                                   // null si el tripulante no tiene sueño (astro_3 / Rodolfo)
          cog: cog,
          vars: porId[bid].variables, nights: porId[bid].noches_disponibles
        });
      }));

      return { crew: crew, aptitud: aptitud, cogEstado: cogEstado };
    },

    // Construye el payload de una sesión cognitiva (PVT) para POST /tripulantes/{id}/cognitivo.
    sesionPVT: function (trials, early) {
      var ordenados = trials.slice().sort(function (a, b) { return a - b; });
      var media = ordenados.reduce(function (x, y) { return x + y; }, 0) / ordenados.length;
      var mediana = ordenados.length % 2 ? ordenados[(ordenados.length - 1) / 2] : (ordenados[ordenados.length / 2 - 1] + ordenados[ordenados.length / 2]) / 2;
      var lapsos = trials.filter(function (t) { return t > 500; }).length;
      return {
        fecha: new Date().toISOString(),
        forma: 'A', semilla: Math.floor(Math.random() * 100000), familiarizacion: false,
        pruebas: { pvt: { rt_media_ms: Math.round(media * 10) / 10, rt_mediana_ms: Math.round(mediana * 10) / 10, lapsos: lapsos, falsos_inicios: early || 0, n_estimulos: trials.length } },
        contexto: { comentario: '' }
      };
    }
  };
})();
