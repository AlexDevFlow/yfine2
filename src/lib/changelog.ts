/**
 * Release notes, shown once per version on the first launch after an update
 * (see ChangelogModal) and on demand from Settings → Privacy & security.
 *
 * Entries live in code rather than in the locale files: a release note is
 * written once, alongside the release, and keeping the four translations of one
 * item next to each other is what stops them drifting apart. `en` is required
 * and is the fallback for any language a note wasn't translated into.
 *
 * Newest version FIRST. `version` must match the app version exactly (the one
 * Tauri reports from tauri.conf.json) or the popup won't fire for it.
 */

export type Localized = { en: string } & Partial<Record<string, string>>;

export type ChangeKind = "new" | "improved" | "fixed";

export interface ChangelogItem {
  kind: ChangeKind;
  title: Localized;
  body?: Localized;
}

export interface ChangelogEntry {
  version: string;
  /** ISO date, shown next to the version. */
  date: string;
  headline?: Localized;
  items: ChangelogItem[];
}

/** Text for the active language, falling back to English. */
export function pick(text: Localized, lang: string | undefined): string {
  if (!lang) return text.en;
  return text[lang] ?? text[lang.split("-")[0]] ?? text.en;
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "0.3.0",
    date: "2026-08-23",
    headline: {
      en: "Your totals now tell you where the money actually went.",
      it: "I totali ora ti dicono dove sono finiti davvero i soldi.",
      es: "Tus totales ahora te dicen adónde fue realmente el dinero.",
      uk: "Ваші підсумки тепер кажуть, куди насправді пішли гроші.",
    },
    items: [
      {
        kind: "new",
        title: {
          en: "Breakdown: click a total, see where it went",
          it: "Analisi: clicca un totale e vedi dov'è finito",
          es: "Análisis: pulsa un total y mira adónde fue",
          uk: "Аналіз: натисніть підсумок і подивіться, куди він пішов",
        },
        body: {
          en: "The Expenses card on the dashboard now opens straight onto charts: a donut of your categories, the largest single movements, the notes that keep repeating (subscriptions and habits), the split by account, and month-by-month and weekday curves. The month-by-month list is still there, one tab away. On Movements, every summary card has a chart button that analyses exactly what your filters select.",
          it: "La scheda Uscite in dashboard ora si apre direttamente sui grafici: una ciambella delle categorie, i movimenti singoli più grandi, le note che si ripetono (abbonamenti e abitudini), la divisione per conto e gli andamenti mese per mese e per giorno della settimana. L'elenco riga per riga resta lì, a una scheda di distanza. Nei Movimenti ogni scheda di riepilogo ha un pulsante che analizza esattamente quello che i filtri stanno selezionando.",
          es: "La tarjeta de gastos del panel ahora se abre directamente en los gráficos: un anillo de tus categorías, los movimientos individuales mayores, las notas que se repiten (suscripciones y hábitos), el reparto por cuenta y las curvas mes a mes y por día de la semana. La lista fila a fila sigue ahí, a una pestaña de distancia. En Movimientos, cada tarjeta de resumen tiene un botón que analiza justo lo que seleccionan tus filtros.",
          uk: "Картка витрат на панелі тепер одразу відкриває графіки: кільцеву діаграму категорій, найбільші окремі рухи, примітки, що повторюються (підписки та звички), розподіл за рахунками та криві по місяцях і днях тижня. Список рядок за рядком нікуди не зник, він на сусідній вкладці. У Рухах кожна підсумкова картка має кнопку, що аналізує саме те, що обирають ваші фільтри.",
        },
      },
      {
        kind: "new",
        title: {
          en: "Compared with the period before",
          it: "Confrontato con il periodo prima",
          es: "Comparado con el periodo anterior",
          uk: "Порівняння з попереднім періодом",
        },
        body: {
          en: "Every breakdown says how the total moved against the same window immediately before it — August against July, not against \"the last 31 days\". Pick the period at the top: this month, last month, the last 3 or 12 months, this year, all time, or whatever your filters already select.",
          it: "Ogni analisi dice come si è mosso il totale rispetto alla stessa finestra immediatamente precedente: agosto contro luglio, non contro «gli ultimi 31 giorni». Il periodo si sceglie in alto: questo mese, mese scorso, ultimi 3 o 12 mesi, quest'anno, sempre, o quello che i filtri già selezionano.",
          es: "Cada análisis dice cómo se movió el total frente a la misma ventana inmediatamente anterior: agosto contra julio, no contra «los últimos 31 días». El periodo se elige arriba: este mes, mes pasado, últimos 3 o 12 meses, este año, todo, o lo que ya seleccionen tus filtros.",
          uk: "Кожен аналіз показує, як змінився підсумок проти такого самого попереднього вікна: серпень проти липня, а не проти «останніх 31 дня». Період обирається вгорі: цей місяць, минулий місяць, останні 3 чи 12 місяців, цей рік, за весь час або те, що вже обрали ваші фільтри.",
        },
      },
      {
        kind: "improved",
        title: {
          en: "Account cards now show the months",
          it: "Le schede dei conti ora mostrano i mesi",
          es: "Las tarjetas de cuenta ahora muestran los meses",
          uk: "Картки рахунків тепер показують місяці",
        },
        body: {
          en: "The little balance chart on every account card is split by month, with a faint rule and a short month label at each boundary — the same treatment the dashboard net-worth chart already had. A 90-day curve now says WHEN the balance moved, not just that it did.",
          it: "Il piccolo grafico del saldo su ogni scheda conto è diviso per mese, con una linea sottile e la sigla del mese a ogni cambio, lo stesso trattamento che il grafico del patrimonio in dashboard aveva già. Una curva di 90 giorni ora dice QUANDO il saldo si è mosso, non solo che si è mosso.",
          es: "El pequeño gráfico de saldo de cada tarjeta de cuenta se divide por mes, con una línea tenue y la abreviatura del mes en cada cambio, el mismo tratamiento que ya tenía el gráfico de patrimonio del panel. Una curva de 90 días ahora dice CUÁNDO se movió el saldo, no solo que se movió.",
          uk: "Невеликий графік балансу на кожній картці рахунку поділено на місяці: тонка лінія та коротка назва місяця на кожній межі, так само як на графіку статків на панелі. Крива за 90 днів тепер каже, КОЛИ баланс змінювався, а не лише що він змінювався.",
        },
      },
    ],
  },
  {
    version: "0.2.0",
    date: "2026-08-16",
    headline: {
      en: "Multi-currency finally adds up, and your accounts show everything they hold.",
      it: "Il multivaluta finalmente torna, e i conti mostrano tutto quello che contengono.",
      es: "El multidivisa por fin cuadra, y tus cuentas muestran todo lo que contienen.",
      uk: "Мультивалютність нарешті сходиться, а рахунки показують усе, що містять.",
    },
    items: [
      {
        kind: "new",
        title: {
          en: "Exchange rates you can actually set",
          it: "Tassi di cambio che puoi davvero impostare",
          es: "Tipos de cambio que puedes configurar",
          uk: "Обмінні курси, які можна задати",
        },
        body: {
          en: "Settings → Currencies, or the Exchange rates button on Portfolios. Type them by hand or fetch them in one click from the European Central Bank (CoinGecko for crypto). Until now there was no way to enter a rate at all, so anything in another currency was left out of your totals.",
          it: "Impostazioni → Valute, oppure il pulsante Tassi di cambio nei Portafogli. Inseriscili a mano o scaricali con un clic dalla Banca Centrale Europea (CoinGecko per le crypto). Fino a ora non esisteva alcun modo di inserire un tasso, quindi tutto ciò che era in un'altra valuta restava fuori dai totali.",
          es: "Ajustes → Divisas, o el botón Tipos de cambio en Carteras. Introdúcelos a mano o descárgalos con un clic del Banco Central Europeo (CoinGecko para cripto). Hasta ahora no había forma de introducir un tipo, así que todo lo que estuviera en otra divisa quedaba fuera de tus totales.",
          uk: "Налаштування → Валюти або кнопка «Обмінні курси» на сторінці портфелів. Введіть вручну або завантажте одним кліком з Європейського центрального банку (CoinGecko для криптовалют).",
        },
      },
      {
        kind: "improved",
        title: {
          en: "One rate per currency is enough",
          it: "Basta un tasso per valuta",
          es: "Basta un tipo por divisa",
          uk: "Достатньо одного курсу на валюту",
        },
        body: {
          en: "Missing pairs are derived from the ones you have: with EUR→USD and EUR→GBP the app works out USD→GBP by itself. Rates also refresh in the background every 12 hours when live prices are on.",
          it: "Le coppie mancanti vengono ricavate da quelle presenti: con EUR→USD ed EUR→GBP l'app calcola da sola USD→GBP. I tassi si aggiornano anche in background ogni 12 ore quando i prezzi live sono attivi.",
          es: "Los pares que faltan se deducen de los que tienes: con EUR→USD y EUR→GBP la app calcula sola USD→GBP. Los tipos también se actualizan en segundo plano cada 12 horas si los precios en vivo están activos.",
          uk: "Відсутні пари виводяться з наявних: маючи EUR→USD і EUR→GBP, застосунок сам обчислить USD→GBP.",
        },
      },
      {
        kind: "fixed",
        title: {
          en: "A new holding gets its price straight away",
          it: "Una nuova posizione ottiene subito il prezzo",
          es: "Una posición nueva obtiene su precio al instante",
          uk: "Нова позиція одразу отримує ціну",
        },
        body: {
          en: "Adding a holding used to leave it valued at your average cost until the next refresh, up to 15 minutes later — which read as the app showing a wrong value. It now fetches the price on the spot.",
          it: "Aggiungendo una posizione restava valorizzata al costo medio fino all'aggiornamento successivo, fino a 15 minuti dopo — e sembrava che l'app mostrasse un valore sbagliato. Ora il prezzo viene scaricato subito.",
          es: "Al añadir una posición se quedaba valorada a tu coste medio hasta la siguiente actualización, hasta 15 minutos después. Ahora el precio se obtiene al momento.",
          uk: "Раніше нова позиція оцінювалася за середньою ціною купівлі до наступного оновлення. Тепер ціна завантажується одразу.",
        },
      },
      {
        kind: "fixed",
        title: {
          en: "Accounts count the money held in their portfolios",
          it: "I conti contano anche i soldi nei portafogli collegati",
          es: "Las cuentas cuentan el dinero de sus carteras",
          uk: "Рахунки враховують гроші у своїх портфелях",
        },
        body: {
          en: "An account whose money sits in a linked portfolio used to read as zero, even though net worth counted it. It now shows cash + portfolios, with the split spelled out underneath.",
          it: "Un conto i cui soldi stanno in un portafoglio collegato risultava a zero, anche se il patrimonio netto li contava. Ora mostra liquidità + portafogli, con il dettaglio sotto.",
          es: "Una cuenta cuyo dinero está en una cartera vinculada aparecía a cero, aunque el patrimonio neto sí lo contaba. Ahora muestra efectivo + carteras, con el desglose debajo.",
          uk: "Рахунок, гроші якого лежать у пов'язаному портфелі, показував нуль. Тепер показує готівку + портфелі з розбивкою.",
        },
      },
      {
        kind: "new",
        title: {
          en: "Choose which accounts make up your net worth",
          it: "Scegli quali conti compongono il patrimonio netto",
          es: "Elige qué cuentas forman tu patrimonio neto",
          uk: "Обирайте, які рахунки формують ваші чисті активи",
        },
        body: {
          en: "The slider button next to the eye on the Dashboard. Excluding an account drops its portfolios too, and the history chart follows the same selection.",
          it: "Il pulsante accanto all'occhio nella Dashboard. Escludendo un conto escludi anche i suoi portafogli, e il grafico storico segue la stessa selezione.",
          es: "El botón junto al ojo en el Panel. Excluir una cuenta excluye también sus carteras, y el gráfico histórico sigue la misma selección.",
          uk: "Кнопка поруч з «оком» на панелі. Виключення рахунку виключає і його портфелі.",
        },
      },
      {
        kind: "improved",
        title: {
          en: "Account pages work like the Movements page",
          it: "Le pagine dei conti funzionano come la pagina Movimenti",
          es: "Las páginas de cuenta funcionan como la de Movimientos",
          uk: "Сторінки рахунків працюють як сторінка рухів",
        },
        body: {
          en: "Search, direction, date range, amount range and tag filters, plus months you can fold away. The balance charts now show month markers along the timeline.",
          it: "Ricerca, direzione, intervallo di date, intervallo di importi e filtri per tag, più i mesi che puoi comprimere. I grafici del saldo mostrano ora i mesi lungo la linea temporale.",
          es: "Búsqueda, dirección, rango de fechas, rango de importes y filtros por etiqueta, además de meses plegables. Los gráficos de saldo ahora muestran los meses en la línea temporal.",
          uk: "Пошук, напрямок, діапазон дат і сум, фільтри за мітками та згортання місяців. На графіках балансу з'явилися позначки місяців.",
        },
      },
      {
        kind: "fixed",
        title: {
          en: "TradingView charts open again",
          it: "I grafici TradingView si aprono di nuovo",
          es: "Los gráficos de TradingView vuelven a abrirse",
          uk: "Графіки TradingView знову відкриваються",
        },
        body: {
          en: "The app's own content-security policy was blocking the chart frame, so the window opened empty. The TradingView host is now allowed — and a test keeps that allowance in step with the code.",
          it: "La content-security policy dell'app bloccava il riquadro del grafico, quindi la finestra si apriva vuota. Ora l'host di TradingView è consentito — e un test tiene quel permesso allineato al codice.",
          es: "La propia content-security policy de la app bloqueaba el marco del gráfico, así que la ventana se abría vacía. Ahora el host de TradingView está permitido, y un test mantiene ese permiso al día.",
          uk: "Власна content-security policy застосунку блокувала фрейм графіка, тому вікно відкривалося порожнім. Тепер хост TradingView дозволено.",
        },
      },
      {
        kind: "improved",
        title: {
          en: "Charts can take the whole window",
          it: "I grafici possono prendersi tutta la finestra",
          es: "Los gráficos pueden ocupar toda la ventana",
          uk: "Графіки можуть зайняти все вікно",
        },
        body: {
          en: "A TradingView chart could never go fullscreen: the app's webview keeps that browser API switched off. The chart window now has its own enlarge button instead.",
          it: "Un grafico TradingView non poteva andare a schermo intero: la webview dell'app tiene disattivata quella API del browser. Ora la finestra del grafico ha un suo pulsante di ingrandimento.",
          es: "Un gráfico de TradingView nunca podía ir a pantalla completa: la webview de la app mantiene esa API del navegador desactivada. Ahora la ventana del gráfico tiene su propio botón de ampliar.",
          uk: "Графік TradingView не міг перейти в повноекранний режим: webview застосунку тримає цей API вимкненим. Тепер вікно графіка має власну кнопку збільшення.",
        },
      },
      {
        kind: "fixed",
        title: {
          en: "A new profile keeps your language",
          it: "Un nuovo profilo mantiene la tua lingua",
          es: "Un perfil nuevo conserva tu idioma",
          uk: "Новий профіль зберігає вашу мову",
        },
        body: {
          en: "Each profile has its own database, and a new one used to start in English regardless of the language you were working in. It now inherits it.",
          it: "Ogni profilo ha il proprio database, e uno nuovo partiva in inglese a prescindere dalla lingua in cui stavi lavorando. Ora la eredita.",
          es: "Cada perfil tiene su propia base de datos, y uno nuevo empezaba en inglés sin importar el idioma en el que estabas trabajando. Ahora lo hereda.",
          uk: "Кожен профіль має власну базу даних, і новий починався англійською незалежно від вашої мови. Тепер він її успадковує.",
        },
      },
      {
        kind: "improved",
        title: {
          en: "Tidier settings",
          it: "Impostazioni più ordinate",
          es: "Ajustes más ordenados",
          uk: "Охайніші налаштування",
        },
        body: {
          en: "Privacy mode, security and updates now share one Privacy & security page; backup/restore and bank imports share Data & import. Page buttons that sat side by side are the same size again, and the in-app help was rewritten to match everything above.",
          it: "Modalità privacy, sicurezza e aggiornamenti stanno ora in un'unica pagina Privacy e sicurezza; backup/ripristino e importazioni bancarie in Dati e importazione. I pulsanti affiancati hanno di nuovo la stessa dimensione, e l'aiuto in-app è stato riscritto per rispecchiare tutto questo.",
          es: "Modo privacidad, seguridad y actualizaciones comparten ahora una página Privacidad y seguridad; copias y importaciones comparten Datos e importación. Los botones contiguos vuelven a tener el mismo tamaño.",
          uk: "Режим приватності, безпека й оновлення тепер на одній сторінці; резервні копії та імпорт — на іншій.",
        },
      },
    ],
  },
];

/** The entry for a version, or undefined when that release has no notes. */
export function changelogFor(version: string): ChangelogEntry | undefined {
  return CHANGELOG.find((e) => e.version === version);
}

/** The newest entry, used by the on-demand "What's new" button. */
export const LATEST_CHANGELOG: ChangelogEntry | undefined = CHANGELOG[0];

/**
 * What to do with the release notes on launch.
 *
 * "stamp" records the version without showing anything — that's a fresh install
 * (nothing to be "new" against) or a version that shipped no notes. "show" is an
 * actual upgrade. A profile that already holds data but has never recorded a
 * version came from a build older than this mechanism, so it counts as an
 * upgrade: otherwise the first release that introduces release notes is the one
 * release nobody ever sees them for.
 */
export function releaseNotesAction(opts: {
  version: string;
  seen: string | null | undefined;
  hasEntry: boolean;
  hasData: boolean;
}): "show" | "stamp" | "skip" {
  const { version, seen, hasEntry, hasData } = opts;
  if (!version) return "skip"; // browser preview: no app version to compare
  if (seen === version) return "skip";
  if (!hasEntry) return "stamp";
  if (!seen && !hasData) return "stamp"; // brand-new install
  return "show";
}
