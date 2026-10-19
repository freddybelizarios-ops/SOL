#!/usr/bin/env python3
"""
Actualiza data/data.json con datos oficiales:
  - Dólar (compra y venta), inflación, promedio de tasas de bancos, Bolsa de Lima, oro, cobre,
    tasa de referencia y bono soberano a 10 años: API oficial del BCRP.
  - Las tasas por entidad (SBS) NO se consultan automáticamente: la web de la SBS tiene
    protección anti-robots. Se mantienen las guardadas en data.json.

Diseño de seguridad:
  - Solo usa la librería estándar de Python (cero dependencias que puedan ser comprometidas).
  - Solo se conecta por HTTPS a estadisticas.bcrp.gob.pe.
  - Valida cada valor (rangos, saltos razonables, nombres). Si algo luce raro, no lo usa.
  - Escribe de forma atómica y solo modifica data/data.json.

Códigos de salida:
  0 = todo bien (o la fuente no respondió y se conservan los datos anteriores).
  1 = alguna fuente devolvió datos sospechosos o cambió de formato. Lo que sí estaba bien
      se guarda igual, y GitHub te avisa por correo para revisar.

Uso:  python3 actualizar_datos.py            -> actualiza
      python3 actualizar_datos.py --validar  -> solo verifica que data.json sea válido
"""
import json
import os
import re
import sys
import time
import unicodedata
import urllib.request
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_FILE = ROOT / "data" / "data.json"
API = "https://estadisticas.bcrp.gob.pe/estadisticas/series/api/{serie}/json/{ini}/{fin}"
SERIE_INFLACION = "PN01273PM"   # IPC Lima Metropolitana, var% 12 meses
SERIE_DOLAR = "PD04640PD"       # Tipo de cambio venta, sistema bancario SBS
SERIE_PROM_BANCOS = "PN07815NM" # Tasa pasiva promedio de bancos, depósitos a plazo 360 días a más (MN)
LIMA = timezone(timedelta(hours=-5))

MESES = {"Ene": 1, "Feb": 2, "Mar": 3, "Abr": 4, "May": 5, "Jun": 6,
         "Jul": 7, "Ago": 8, "Sep": 9, "Set": 9, "Oct": 10, "Nov": 11, "Dic": 12}
RE_MES = re.compile(r"^([A-Z][a-z]{2})\.(\d{4})$")        # Ago.2026
RE_DIA = re.compile(r"^(\d{2})\.([A-Z][a-z]{2})\.(\d{2})$")  # 02.Oct.26
LABEL_RE = re.compile(r"^[0-9A-Za-zÁÉÍÓÚÜáéíóúüÑñ.\- ()]{1,40}$")  # igual que en la app

MAX_INFLACION_PUNTOS = 36
MAX_DOLAR_PUNTOS = 30


class DatosSospechosos(Exception):
    pass


# ---------------------------------------------------------------- red
HOSTS_PERMITIDOS = ("https://estadisticas.bcrp.gob.pe/",)


def descargar(url, intentos=3):
    """Devuelve el texto de la URL o None si la fuente no responde."""
    if not url.startswith(HOSTS_PERMITIDOS):
        raise ValueError("URL no permitida")
    req = urllib.request.Request(url, headers={"User-Agent": "Soles-PWA/1.0 (actualizador de datos)",
                                               "Accept": "application/json,text/html"})
    for i in range(intentos):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                cuerpo = r.read(500_000)  # límite de tamaño
                return cuerpo.decode("utf-8", errors="replace")
        except Exception as e:  # noqa: BLE001
            print(f"  intento {i + 1}/{intentos} falló: {e}")
            time.sleep(5 * (i + 1))
    return None


def leer_serie(serie, ini, fin, descargar_fn=descargar):
    """Devuelve lista de (etiqueta, valor) o None si no hubo respuesta útil."""
    texto = descargar_fn(API.format(serie=serie, ini=ini, fin=fin))
    if not texto:
        return None
    a, b = texto.find("{"), texto.rfind("}")
    if a == -1 or b == -1:
        return None
    try:
        data = json.loads(texto[a:b + 1])
        periodos = data["periods"]
    except (ValueError, KeyError, TypeError):
        return None
    puntos = []
    for p in periodos:
        try:
            nombre = str(p["name"]).strip()
            valor = float(p["values"][0])  # "n.d." -> ValueError -> se omite
        except (KeyError, IndexError, TypeError, ValueError):
            continue
        if valor != valor:  # NaN
            continue
        puntos.append((nombre, valor))
    return puntos or None


# ---------------------------------------------------------------- fechas
def clave_mes(etiqueta):
    m = RE_MES.match(etiqueta)
    if not m or m.group(1) not in MESES:
        raise DatosSospechosos(f"etiqueta de mes desconocida: {etiqueta!r}")
    return (int(m.group(2)), MESES[m.group(1)])


def clave_dia(etiqueta):
    m = RE_DIA.match(etiqueta)
    if not m or m.group(2) not in MESES:
        raise DatosSospechosos(f"etiqueta de día desconocida: {etiqueta!r}")
    return (2000 + int(m.group(3)), MESES[m.group(2)], int(m.group(1)))


# ---------------------------------------------------------------- validación
def validar_serie(puntos, clave, minimo, maximo, salto_max, nombre):
    if not puntos:
        raise DatosSospechosos(f"{nombre}: serie vacía")
    previo = None
    for etiqueta, v in puntos:
        if not LABEL_RE.match(etiqueta):
            raise DatosSospechosos(f"{nombre}: etiqueta inválida {etiqueta!r}")
        clave(etiqueta)
        if not (minimo <= v <= maximo):
            raise DatosSospechosos(f"{nombre}: valor fuera de rango {etiqueta}={v}")
        if previo is not None and abs(v - previo) > salto_max:
            raise DatosSospechosos(f"{nombre}: salto anormal a {etiqueta} ({previo} -> {v})")
        previo = v


def fusionar(actuales, nuevos, clave, maximo):
    """Une ambas series por etiqueta (lo nuevo manda), ordena por fecha y recorta."""
    por_clave = {}
    for etiqueta, v in actuales:
        por_clave[clave(etiqueta)] = (etiqueta, v)
    for etiqueta, v in nuevos:
        por_clave[clave(etiqueta)] = (etiqueta, round(v, 3))
    ordenados = [por_clave[k] for k in sorted(por_clave)]
    return ordenados[-maximo:]


# ---------------------------------------------------------------- tasas SBS
SBS_URL = "https://www.sbs.gob.pe/app/pp/EstadisticasSAEEPortal/Paginas/TIPasivaDepositoEmpresa.aspx?tip={tip}"
SBS_TIPOS = {"B": "banco", "C": "caja", "F": "fin"}
TASA_MIN, TASA_MAX = 0.5, 15.0      # rango razonable de una TEA de depósito a plazo
SALTO_TASA_MAX = 5.0                # puntos; un cambio mayor en un día se considera sospechoso
NO_ENTIDAD = ("promedio", "total", "tasa", "moneda", "plazo", "deposito", "dias", "anual", "empresa",
              "ahorro", "cts", "sistema", "nota", "fuente", "personas", "naturales", "juridicas", "mes")

# Nombres de la SBS -> nombres amigables en la app (el resto se limpia automáticamente).
NOMBRES = [
    (r"^cmcp\b|metropolitana", "Caja Metropolitana"),
    (r"^cmac\s+(.+)$", "Caja {0}"),
    (r"^crac\s+(.+)$", "Caja Rural {0}"),
    (r"credito del peru|^b\.?\s*de credito|^bcp$|^credito$", "BCP"),
    (r"bbva|continental", "BBVA"),
    (r"interamericano|banbif", "BanBif"),
    (r"^(b\.?|banco)\s*falabella|^falabella", "Banco Falabella"),
    (r"^(b\.?|banco)\s*ripley|^ripley", "Banco Ripley"),
    (r"^(b\.?|banco)\s*pichincha|^pichincha", "Banco Pichincha"),
    (r"^(b\.?|banco)\s*gnb|^gnb", "Banco GNB"),
    (r"^(b\.?|banco)\s*santander|^santander", "Santander"),
    (r"^(b\.?|banco)\s*(de comercio)$|^comercio$", "Banco de Comercio"),
    (r"^(b\.?|banco)\s*(.+)$", "{1}"),
]


def normalizar(t):
    t = unicodedata.normalize("NFKD", t).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"\s+", " ", t).strip().lower()


def nombre_amigable(original):
    # Un nombre real de banco/caja nunca trae estos caracteres o palabras: se rechaza, no se "limpia".
    if re.search(r"[<>=\"'`{};/\\]", original) or re.search(r"script|onerror|onload|javascript|http", original, re.I):
        return None
    limpio = re.sub(r"\s+", " ", original).strip()
    n = normalizar(limpio)
    for patron, plantilla in NOMBRES:
        m = re.search(patron, n)
        if m:
            grupos = [g.title() if g else "" for g in m.groups()]
            limpio = plantilla.format(*grupos) if grupos else plantilla
            break
    else:
        if limpio.isupper():
            limpio = limpio.title()
    limpio = re.sub(r"[^0-9A-Za-zÁÉÍÓÚÜáéíóúüÑñ.\- ()]", "", limpio).strip()[:40]
    return limpio if LABEL_RE.match(limpio) else None


class _Tablas(HTMLParser):
    """Extrae todas las tablas como listas de filas de texto (repite celdas con colspan)."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tablas, self._pila, self._fila, self._celda, self._span = [], [], None, None, 1

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self._pila.append([])
        elif tag == "tr" and self._pila:
            self._fila = []
        elif tag in ("td", "th") and self._fila is not None:
            self._celda = []
            try:
                self._span = max(1, min(20, int(dict(attrs).get("colspan") or 1)))
            except ValueError:
                self._span = 1
        elif tag == "br" and self._celda is not None:
            self._celda.append(" ")

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self._celda is not None and self._fila is not None:
            texto = re.sub(r"\s+", " ", "".join(self._celda)).strip()
            self._fila.extend([texto] * self._span)
            self._celda = None
        elif tag == "tr" and self._fila is not None and self._pila:
            if self._fila:
                self._pila[-1].append(self._fila)
            self._fila = None
        elif tag == "table" and self._pila:
            self.tablas.append(self._pila.pop())

    def handle_data(self, data):
        if self._celda is not None:
            self._celda.append(data)


def _es_entidad(celda):
    n = normalizar(celda)
    return (2 <= len(n) <= 60 and re.search(r"[a-z]", n) is not None
            and not re.search(r"\b(" + "|".join(NO_ENTIDAD) + r")\b", n) and "%" not in n)


def _numero(celda):
    t = celda.replace("%", "").replace(" ", "").strip()
    if re.fullmatch(r"\d{1,2}[.,]\d{1,4}|\d{1,2}", t):
        return float(t.replace(",", "."))
    return None


def leer_tasas_sbs(html):
    """
    Busca, en la primera tabla que tenga una fila 'Más de 360 días', los valores por entidad.
    Devuelve [(nombre_amigable, tasa)] o lanza DatosSospechosos si el formato no se reconoce.
    """
    parser = _Tablas()
    parser.feed(html)
    for tabla in parser.tablas:
        cabecera = None
        for fila in tabla:
            entidades = [i for i, c in enumerate(fila) if _es_entidad(c)]
            if len(entidades) >= 3:
                cabecera = (fila, entidades)
                continue
            etiqueta = " ".join(normalizar(c) for c in fila[:3])
            if cabecera and re.search(r"mas de 360|> ?360|360 dias a mas", etiqueta):
                cab, idxs = cabecera
                resultado, vistos = [], set()
                for i in idxs:
                    desde_derecha = len(cab) - 1 - i          # alinear por la derecha (rowspan a la izquierda)
                    j = len(fila) - 1 - desde_derecha
                    if j < 0 or j >= len(fila):
                        continue
                    v = _numero(fila[j])
                    nombre = nombre_amigable(cab[i])
                    if v is None or nombre is None or nombre in vistos:
                        continue
                    vistos.add(nombre)
                    resultado.append((nombre, round(v, 2)))
                if len(resultado) < 2:
                    raise DatosSospechosos("SBS: fila 'más de 360 días' sin valores reconocibles")
                return resultado
    raise DatosSospechosos("SBS: no se encontró la tabla de tasas (¿cambió el formato de la página?)")


def actualizar_tasas(rates_actuales, hoy, descargar_fn=descargar):
    """
    Devuelve (rates_nuevas | None, alertas, cambios).
    None = no se pudo actualizar nada (se conservan las tasas anteriores).
    """
    alertas, cambios = [], []
    previas_sbs = rates_actuales.get("source") == "SBS"
    previas = {(r[1], r[0]): r[2] for r in rates_actuales.get("items", [])}
    por_tipo = {}
    for tip, tipo in SBS_TIPOS.items():
        html = descargar_fn(SBS_URL.format(tip=tip))
        if not html:
            print(f"  SBS ({tipo}) sin respuesta: se conservan las tasas anteriores.")
            continue
        try:
            filas = leer_tasas_sbs(html)
        except DatosSospechosos as e:
            alertas.append(f"{tipo}: {e}")
            continue
        items = []
        for nombre, tasa in filas:
            anterior = previas.get((tipo, nombre))
            if tasa < TASA_MIN:
                continue  # sin operaciones a ese plazo en el mes: se omite esa entidad
            if tasa > TASA_MAX:
                alertas.append(f"{nombre}: tasa fuera de rango ({tasa}%)" +
                               (", se conserva la anterior" if previas_sbs and anterior is not None else ", se omite"))
                if previas_sbs and anterior is not None:
                    items.append([nombre, tipo, anterior])
                continue
            if previas_sbs and anterior is not None and abs(tasa - anterior) > SALTO_TASA_MAX:
                alertas.append(f"{nombre}: salto de {anterior}% a {tasa}% en un día, se conserva el anterior")
                tasa = anterior
            items.append([nombre, tipo, tasa])
        if len(items) < 2:
            alertas.append(f"{tipo}: muy pocas entidades válidas ({len(items)})")
            continue
        por_tipo[tipo] = items

    if not por_tipo:
        return None, alertas, cambios
    if not previas_sbs and len(por_tipo) < len(SBS_TIPOS):
        # Primera vez: solo se cambia a datos SBS si llegaron los tres grupos completos.
        alertas.append("primera carga SBS incompleta: se mantienen las tasas referenciales")
        return None, alertas, cambios

    items = []
    for tipo in SBS_TIPOS.values():
        if tipo in por_tipo:
            items.extend(por_tipo[tipo])
        else:  # este grupo falló hoy: se conservan sus tasas SBS anteriores
            items.extend([list(r) for r in rates_actuales.get("items", []) if r[1] == tipo])
    items.sort(key=lambda r: -r[2])
    items = items[:60]
    cambios.append(f"tasas SBS: {len(items)} entidades, mejor {items[0][0]} {items[0][2]}%")
    return {"source": "SBS", "asOf": hoy.strftime("%Y-%m-%d"), "items": items}, alertas, cambios


# ---------------------------------------------------------------- promedio de bancos (BCRP)
def actualizar_prom_bancos(nueva, hoy, descargar_fn=descargar):
    """Actualiza nueva['bankAvg']. Devuelve (cambios, alertas). Nunca afecta al resto de datos."""
    serie = leer_serie(SERIE_PROM_BANCOS, f"{hoy.year - 1}-1", f"{hoy.year}-12", descargar_fn)
    if not serie:
        print("  BCRP sin datos del promedio de bancos: se conserva el anterior.")
        return [], []
    etiqueta, valor = serie[-1][0], round(serie[-1][1], 2)
    try:
        validar_serie([(etiqueta, valor)], clave_mes, 0.5, 15, 99, "promedio bancos")
        previo = nueva.get("bankAvg")
        if previo:
            if clave_mes(etiqueta) < clave_mes(previo["period"]):
                raise DatosSospechosos("promedio bancos: el dato retrocedió en el tiempo")
            if abs(valor - previo["value"]) > 2:
                raise DatosSospechosos(f"promedio bancos: salto anormal ({previo['value']} -> {valor})")
    except DatosSospechosos as e:
        return [], [str(e)]
    nuevo = {"source": "BCRP", "period": etiqueta, "value": valor}
    if nuevo == nueva.get("bankAvg"):
        return [], []
    nueva["bankAvg"] = nuevo
    return [f"promedio bancos {etiqueta} = {valor}%"], []


# ---------------------------------------------------------------- mercados (BCRP, diario)
# Una sola consulta con varias series diarias (la API permite hasta 10 de la misma frecuencia).
# El BCRP puede devolverlas en otro orden: se identifican por NOMBRE, nunca por posición.
MERCADOS = {
    #  clave:   (código,      patrón del nombre BCRP,                      mín,   máx,     salto máx, tipo de salto)
    "bvl":    ("PD38026MD", r"General Burs[aá]til BVL \(.ndice\)",       1000,  500000,  0.15, "rel"),
    "gold":   ("PD04704XD", r"\bOro\b",                                  100,   20000,   0.15, "rel"),
    "copper": ("PD04701XD", r"\bCobre\b",                                50,    3000,    0.15, "rel"),
    "ref":    ("PD12301MD", r"Tasa de Referencia",                         0,     20,      1.0,  "abs"),
    "bond10": ("PD31893DD", r"Bono del gobierno peruano a 10 a.os \(en S/\)", 0,  25,     1.5,  "abs"),
    "fxBuy":  ("PD04639PD", r"Sistema bancario SBS.*Compra",               1,     10,      0.25, "abs"),
}
MAX_MERCADO_PUNTOS = 30


def leer_series_por_nombre(codigos, ini, fin, descargar_fn=descargar):
    """Devuelve [(nombre_serie, [(etiqueta, valor), ...]), ...] o None si no hubo respuesta útil."""
    texto = descargar_fn(API.format(serie="-".join(codigos), ini=ini, fin=fin))
    if not texto:
        return None
    a, b = texto.find("{"), texto.rfind("}")
    if a == -1 or b == -1:
        return None
    try:
        data = json.loads(texto[a:b + 1])
        nombres = [str(x["name"]) for x in data["config"]["series"]]
        periodos = data["periods"]
    except (ValueError, KeyError, TypeError):
        return None
    salida = [(n, []) for n in nombres]
    for p in periodos:
        try:
            etiqueta = str(p["name"]).strip()
            valores = p["values"]
        except (KeyError, TypeError):
            continue
        for i, crudo in enumerate(valores[:len(nombres)]):
            try:
                v = float(crudo)
            except (TypeError, ValueError):
                continue  # "n.d."
            if v == v:
                salida[i][1].append((etiqueta, v))
    return salida


def validar_mercado(puntos, minimo, maximo, salto, tipo, nombre):
    previo = None
    for etiqueta, v in puntos:
        if not LABEL_RE.match(etiqueta):
            raise DatosSospechosos(f"{nombre}: etiqueta inválida {etiqueta!r}")
        clave_dia(etiqueta)
        if not (minimo <= v <= maximo):
            raise DatosSospechosos(f"{nombre}: valor fuera de rango {etiqueta}={v}")
        if previo is not None:
            cambio = abs(v - previo) / previo if tipo == "rel" and previo else abs(v - previo)
            if cambio > salto:
                raise DatosSospechosos(f"{nombre}: salto anormal a {etiqueta} ({previo} -> {v})")
        previo = v


def actualizar_mercados(nueva, hoy, descargar_fn=descargar):
    """Actualiza nueva['markets']. Devuelve (cambios, alertas). Cada serie es independiente."""
    ini = (hoy - timedelta(days=45)).strftime("%Y-%m-%d")
    fin = hoy.strftime("%Y-%m-%d")
    series = leer_series_por_nombre([c[0] for c in MERCADOS.values()], ini, fin, descargar_fn)
    if not series:
        print("  BCRP sin datos de mercados: se conservan los anteriores.")
        return [], []
    actuales = (nueva.get("markets") or {}).get("items") or {}
    items = {k: [list(p) for p in v] for k, v in actuales.items() if k in MERCADOS}
    cambios, alertas = [], []
    for clave, (codigo, patron, mn, mx, salto, tipo) in MERCADOS.items():
        encontrados = [pts for nombre, pts in series if re.search(patron, nombre, re.I)]
        if len(encontrados) != 1 or not encontrados[0]:
            continue  # serie ausente o sin datos hoy: se conserva lo anterior
        nuevos = [(e, round(v, 3)) for e, v in encontrados[0]]
        previos = [tuple(p) for p in items.get(clave, [])]
        try:
            validar_mercado(nuevos, mn, mx, salto, tipo, clave)
            fusion = fusionar(previos, nuevos, clave_dia, MAX_MERCADO_PUNTOS)
            validar_mercado(fusion[-(len(nuevos) + 1):], mn, mx, salto, tipo, clave + " (fusionado)")
            if previos and clave_dia(fusion[-1][0]) < clave_dia(previos[-1][0]):
                raise DatosSospechosos(f"{clave}: el dato más reciente retrocedió en el tiempo")
        except DatosSospechosos as e:
            alertas.append(str(e))
            continue
        if fusion != previos:
            cambios.append(f"{clave} {fusion[-1][0]}={fusion[-1][1]}")
        items[clave] = [list(p) for p in fusion]
    if items:
        nueva["markets"] = {"source": "BCRP", "items": items}
    return cambios, alertas


# ---------------------------------------------------------------- validación final (igual que la app)
def validar_data(d):
    def puntos(arr, lo, hi):
        assert isinstance(arr, list) and 1 <= len(arr) <= 400
        for p in arr:
            assert isinstance(p, list) and len(p) == 2
            assert isinstance(p[0], str) and LABEL_RE.match(p[0])
            assert isinstance(p[1], (int, float)) and lo <= p[1] <= hi
    assert d.get("version") == 1
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", d.get("updated", ""))
    puntos(d["inflation"]["points"], -10, 50)
    puntos(d["fx"]["points"], 1, 10)
    items = d["rates"]["items"]
    assert isinstance(items, list) and 1 <= len(items) <= 60
    for r in items:
        assert isinstance(r, list) and len(r) == 3
        assert isinstance(r[0], str) and LABEL_RE.match(r[0])
        assert r[1] in ("caja", "banco", "fin")
        assert isinstance(r[2], (int, float)) and 0 <= r[2] <= 25
    if "markets" in d:
        m = d["markets"]
        assert isinstance(m, dict) and isinstance(m.get("items"), dict)
        for k, pts in m["items"].items():
            assert k in MERCADOS
            puntos(pts, MERCADOS[k][2], MERCADOS[k][3])
    if "bankAvg" in d:
        b = d["bankAvg"]
        assert isinstance(b, dict) and isinstance(b.get("period"), str) and LABEL_RE.match(b["period"])
        assert isinstance(b.get("value"), (int, float)) and 0 <= b["value"] <= 25


# ---------------------------------------------------------------- principal
def actualizar(data, hoy, descargar_fn=descargar):
    """Dólar e inflación. Devuelve (data_nueva, cambios). Lanza DatosSospechosos si algo no cuadra."""
    nueva = json.loads(json.dumps(data))  # copia profunda
    cambios = []

    inf_act = [tuple(p) for p in data["inflation"]["points"]]
    inf_nuevos = leer_serie(SERIE_INFLACION, f"{hoy.year - 3}-1", f"{hoy.year}-12", descargar_fn)
    if inf_nuevos:
        inf_nuevos = [(e, round(v, 2)) for e, v in inf_nuevos]
        validar_serie(inf_nuevos, clave_mes, -5, 30, 5, "inflación")
        fusion = fusionar(inf_act, inf_nuevos, clave_mes, MAX_INFLACION_PUNTOS)
        validar_serie(fusion, clave_mes, -5, 30, 5, "inflación (fusionada)")
        if clave_mes(fusion[-1][0]) < clave_mes(inf_act[-1][0]):
            raise DatosSospechosos("inflación: el dato más reciente retrocedió en el tiempo")
        if fusion != inf_act:
            cambios.append(f"inflación hasta {fusion[-1][0]} = {fusion[-1][1]}%")
        nueva["inflation"]["points"] = [list(p) for p in fusion]
    else:
        print("  BCRP sin datos de inflación: se conservan los anteriores.")

    fx_act = [tuple(p) for p in data["fx"]["points"]]
    ini = hoy - timedelta(days=45)
    fx_nuevos = leer_serie(SERIE_DOLAR, ini.strftime("%Y-%m-%d"), hoy.strftime("%Y-%m-%d"), descargar_fn)
    if fx_nuevos:
        validar_serie(fx_nuevos, clave_dia, 2.5, 5.5, 0.25, "dólar")
        fusion = fusionar(fx_act, fx_nuevos, clave_dia, MAX_DOLAR_PUNTOS)
        validar_serie(fusion[-len(fx_nuevos):], clave_dia, 2.5, 5.5, 0.25, "dólar (fusionado)")
        if clave_dia(fusion[-1][0]) < clave_dia(fx_act[-1][0]):
            raise DatosSospechosos("dólar: el dato más reciente retrocedió en el tiempo")
        if fusion != fx_act:
            cambios.append(f"dólar al {fusion[-1][0]} = S/ {fusion[-1][1]}")
        nueva["fx"]["points"] = [list(p) for p in fusion]
    else:
        print("  BCRP sin datos del dólar: se conservan los anteriores.")

    if inf_nuevos or fx_nuevos:
        nueva["updated"] = hoy.strftime("%Y-%m-%d")
    return nueva, cambios


def escribir_atomico(ruta, contenido):
    tmp = ruta.with_suffix(".tmp")
    tmp.write_text(contenido, encoding="utf-8")
    os.replace(tmp, ruta)


def main(argv):
    if "--validar" in argv:
        try:
            validar_data(json.loads(DATA_FILE.read_text(encoding="utf-8")))
            print("data.json válido.")
            return 0
        except Exception as e:  # noqa: BLE001
            print(f"data.json INVÁLIDO: {e!r}")
            return 1

    hoy = datetime.now(LIMA).date()
    print(f"Actualizando datos de Soles — {hoy} (hora de Lima)")
    data = json.loads(DATA_FILE.read_text(encoding="utf-8"))
    alertas = []

    # 1) BCRP: dólar e inflación
    try:
        nueva, cambios = actualizar(data, hoy)
    except DatosSospechosos as e:
        alertas.append(f"BCRP: {e}")
        nueva, cambios = json.loads(json.dumps(data)), []

    # 2) Promedio de tasas de bancos (BCRP, mensual): referencia automática
    c_prom, a_prom = actualizar_prom_bancos(nueva, hoy)
    cambios += c_prom
    alertas += a_prom

    # 3) Mercados: bolsa, oro, cobre, tasa de referencia, bono 10 años y dólar compra
    c_mkt, a_mkt = actualizar_mercados(nueva, hoy)
    cambios += c_mkt
    alertas += a_mkt

    # 4) Tasas por entidad: la web de la SBS bloquea a propósito el acceso automático
    #    (protección anti-robots), así que NO se consultan aquí. Se conservan las de data.json,
    #    que se actualizan aparte leyendo la SBS como una visita normal de navegador.

    # 5) Validación final idéntica a la de la app antes de escribir
    try:
        validar_data(nueva)
    except Exception as e:  # noqa: BLE001
        print(f"ALERTA: el resultado no pasó la validación final, no se escribe nada: {e!r}")
        return 1

    if nueva != data:
        escribir_atomico(DATA_FILE, json.dumps(nueva, ensure_ascii=False, indent=1) + "\n")
        print("Actualizado:", "; ".join(cambios) if cambios else "fecha de revisión")
    else:
        print("Sin cambios.")

    for a in alertas:
        print(f"ALERTA: {a}")
    return 1 if alertas else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
