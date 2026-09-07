/* =============================================================================
   SERVICIO DE ANOTACIONES  ·  Cloudflare Worker
   =============================================================================
   Guarda las anotaciones del dashboard en un archivo JSON de GitHub.
   El token de GitHub vive aquí, en el servidor: nunca llega al navegador.
   Por eso los usuarios del dashboard no se loguean ni configuran nada.

   ---------------------------------------------------------------------------
   CÓMO DESPLEGARLO (una sola vez, ~10 minutos)
   ---------------------------------------------------------------------------
   1. Crea el token en GitHub:
      Settings → Developer settings → Personal access tokens → Fine-grained
      · Repository access: SOLO el repositorio donde vivirá anotaciones.json
      · Permisos: Contents → Read and write
      · Ponle fecha de expiración y anótala en tu calendario

   2. Crea el Worker en https://dash.cloudflare.com (plan gratuito):
      Workers & Pages → Create → Worker → Deploy
      Luego "Edit code", pega este archivo completo y vuelve a desplegar.

   3. Configura las variables en Settings → Variables and Secrets:
      REPO         (texto)   ej. mi-usuario/mi-repositorio
      BRANCH       (texto)   ej. main
      FILE_PATH    (texto)   ej. anotaciones.json
      ORIGEN       (texto)   ej. https://mi-usuario.github.io   ← ver nota abajo
      GITHUB_TOKEN (SECRET)  el token del paso 1  ← debe ser Secret, no texto

   4. Copia la URL del Worker (algo como
      https://anotaciones.TU-CUENTA.workers.dev) y pégala en index.html,
      en la constante ANOTACIONES_API.

   ---------------------------------------------------------------------------
   SOBRE "ORIGEN"
   ---------------------------------------------------------------------------
   Limita qué página puede llamar al servicio desde un navegador. Es una
   protección útil contra el uso casual desde otros sitios, pero NO es
   seguridad real: la cabecera Origin se puede falsificar con cualquier
   herramienta de línea de comandos. Si no la defines, se acepta cualquier
   origen. Ver "LÍMITES" al final del archivo.
============================================================================= */

const GH_API = 'https://api.github.com';
const MAX_LEN = 5000;      // caracteres por anotación
const MAX_NOTAS = 2000;    // anotaciones distintas en el archivo
const REINTENTOS = 3;      // si otra persona guarda al mismo tiempo

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ORIGEN || '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin'
    };

    const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
      status,
      headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
    });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const faltan = ['REPO', 'BRANCH', 'FILE_PATH', 'GITHUB_TOKEN'].filter(k => !env[k]);
    if (faltan.length) return json({ error: 'Falta configurar en el Worker: ' + faltan.join(', ') }, 500);

    if (env.ORIGEN) {
      const origen = request.headers.get('Origin');
      if (origen && origen !== env.ORIGEN) return json({ error: 'Origen no permitido.' }, 403);
    }

    try {
      if (request.method === 'GET') {
        const { notas } = await leerNotas(env);
        return json(notas);
      }

      if (request.method === 'POST') {
        let body;
        try { body = await request.json(); }
        catch (e) { return json({ error: 'El cuerpo de la petición no es JSON válido.' }, 400); }

        const cod = String(body.cod ?? '').trim();
        const texto = String(body.texto ?? '').trim();

        if (!cod) return json({ error: 'Falta el código de proyecto.' }, 400);
        if (cod.length > 100) return json({ error: 'El código de proyecto es demasiado largo.' }, 400);
        if (texto.length > MAX_LEN) {
          return json({ error: `La anotación supera los ${MAX_LEN} caracteres.` }, 413);
        }

        const notas = await guardarNota(env, cod, texto);
        return json(notas);
      }

      return json({ error: 'Método no permitido.' }, 405);
    } catch (e) {
      return json({ error: e.message || 'Error inesperado en el servicio.' }, 502);
    }
  }
};

/* ------------------------- GitHub Contents API ------------------------- */

function ghHeaders(env) {
  return {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Authorization': 'Bearer ' + env.GITHUB_TOKEN,
    // GitHub rechaza las peticiones sin User-Agent
    'User-Agent': 'dashboard-anotaciones-worker'
  };
}

function contentsUrl(env) {
  const ruta = String(env.FILE_PATH).replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
  return `${GH_API}/repos/${env.REPO}/contents/${ruta}`;
}

async function mensajeError(res) {
  let detalle = '';
  try { const j = await res.json(); detalle = j.message || ''; } catch (e) {}
  if (res.status === 401) return 'El token de GitHub del servicio es inválido o expiró.';
  if (res.status === 403) return 'GitHub rechazó la petición (permisos o límite de peticiones). ' + detalle;
  if (res.status === 404) return 'No se encontró el repositorio, la rama o la ruta configurada en el Worker.';
  return `GitHub respondió ${res.status}. ${detalle}`;
}

// Devuelve { notas, sha }. Si el archivo aún no existe: notas vacías y sha null.
async function leerNotas(env) {
  const url = contentsUrl(env) + '?ref=' + encodeURIComponent(env.BRANCH);
  const res = await fetch(url, { headers: ghHeaders(env), cf: { cacheTtl: 0 } });

  if (res.status === 404) return { notas: {}, sha: null };
  if (!res.ok) throw new Error(await mensajeError(res));

  const data = await res.json();
  const texto = data.content ? decodificar(data.content).trim() : '';
  let notas = {};
  if (texto) {
    try { notas = JSON.parse(texto); }
    catch (e) { throw new Error('El archivo de anotaciones del repositorio no es JSON válido.'); }
  }
  return { notas, sha: data.sha || null };
}

// Relee, aplica un solo cambio y escribe. Si alguien guardó entremedio,
// GitHub rechaza el sha y se reintenta con el contenido actualizado.
async function guardarNota(env, cod, texto) {
  let ultimoError = null;

  for (let intento = 0; intento < REINTENTOS; intento++) {
    const { notas, sha } = await leerNotas(env);

    if (texto) {
      if (!(cod in notas) && Object.keys(notas).length >= MAX_NOTAS) {
        throw new Error(`Se alcanzó el máximo de ${MAX_NOTAS} anotaciones.`);
      }
      notas[cod] = texto;
    } else {
      delete notas[cod];
    }

    const body = {
      message: (texto ? 'Anotación: ' : 'Elimina anotación: ') + cod,
      content: codificar(JSON.stringify(ordenar(notas), null, 2) + '\n'),
      branch: env.BRANCH
    };
    if (sha) body.sha = sha;

    const res = await fetch(contentsUrl(env), {
      method: 'PUT',
      headers: { ...ghHeaders(env), 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (res.ok) return notas;

    // 409/422 = el archivo cambió entre la lectura y la escritura: reintentar
    if (res.status === 409 || res.status === 422) {
      ultimoError = new Error('Otra persona guardó al mismo tiempo.');
      continue;
    }
    throw new Error(await mensajeError(res));
  }

  throw new Error((ultimoError && ultimoError.message ? ultimoError.message + ' ' : '') +
    'No se pudo guardar tras varios intentos. Vuelve a intentarlo.');
}

/* ------------------------------ Utilidades ------------------------------ */

// Claves ordenadas: mantiene los diffs de los commits legibles
function ordenar(obj) {
  const salida = {};
  Object.keys(obj).sort().forEach(k => { salida[k] = obj[k]; });
  return salida;
}

function codificar(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin);
}

function decodificar(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}

/* =============================================================================
   LÍMITES QUE CONVIENE TENER PRESENTES
   -----------------------------------------------------------------------------
   · Sin login, cualquiera que conozca esta URL puede escribir o borrar
     anotaciones. ORIGEN reduce el uso casual desde otras páginas, pero no
     impide una petición hecha a propósito desde fuera del navegador.
   · El daño es reversible: cada cambio es un commit, así que el historial de
     GitHub permite recuperar cualquier versión anterior del archivo.
   · Si el repositorio del JSON es público, las anotaciones son públicas.
     Ponlo en un repositorio privado si el contenido es interno: el Worker
     puede leerlo igual porque usa el token.
   · Conviene que el JSON viva en un repositorio distinto al del dashboard:
     el token puede escribir en todo el repositorio al que tiene acceso.
============================================================================= */
