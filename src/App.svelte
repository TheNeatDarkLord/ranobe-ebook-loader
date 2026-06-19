<script lang="ts">
    import type { ImageInfoMap, EbookFormat, ImageInfo } from './utils';
    import type { Base, Chapter } from './loaders/Base';

    import { Ranobe } from './loaders/Ranobe';
    import { Ranobes } from './loaders/Ranobes';
    import { Rulate } from './loaders/Rulate';
    import { Jaomix } from './loaders/Jaomix';

    import fb2Description from './templates/fb2/description.pug';
    import fb2Content from './templates/fb2/content.pug';

    import epubToc from './templates/epub/toc.pug';
    import epubNav from './templates/epub/nav.pug';
    import epubOpf from './templates/epub/opf.pug';
    import epubChapter from './templates/epub/chapter.pug';
    import epubPage from './templates/epub/page.pug';

    import epubContainer from './templates/epub/container.static.pug';
    import epubApple from './templates/epub/apple.static.pug';

    import Window from './Window.svelte';
    import Preloader from './Preloader.svelte';
    import ContextMenu from './ContextMenu.svelte';
    import ContextMenuItem from './ContextMenuItem.svelte';
    import NotificationsDisplay from './NotificationsDisplay.svelte';
    import { saveAs } from 'file-saver';
    import { onMount, onDestroy, tick } from 'svelte';
    import { processHtml, parse, downloadImage, inject, patchApi, formats, uniqValues } from './utils';
    import waitEvents from './wait-events';
    import { concurrency } from './loaders/Base';
    import { createUUIDv5 } from './uuid';
    import { zip } from './zip';
    import { progress, notifications } from './stores';
    import { sha256 } from './string-utils';
    import { cacheCount } from './cache';

    const MENU_TITLE_FB2 = 'Скачать *.fb2';
    const MENU_TITLE_EPUB = 'Скачать *.epub';

    // Автодокачка: при блоке антиботом перезагружаем страницу и продолжаем с места.
    const RESUME_KEY = 'reb-autoresume';
    const getResume = (): any => { try { return JSON.parse(sessionStorage.getItem(RESUME_KEY)) || null; } catch { return null; } };
    const setResume = (v: any) => { try { sessionStorage.setItem(RESUME_KEY, JSON.stringify(v)); } catch {} };
    const clearResume = () => { try { sessionStorage.removeItem(RESUME_KEY); } catch {} };
    const Loader = {
        'ранобэ.рф': Ranobe,
        'xn--80ac9aeh6f.xn--p1ai': Ranobe,
        'ranobes.com': Ranobes,
        'ranobes.top': Ranobes,
        'ranobes.net': Ranobes,
        'tl.rulate.ru': Rulate,
        'jaomix.ru': Jaomix,
    }[location.hostname];

    let loading = false;
    let ctrl: AbortController;
    let injectTarget: HTMLElement = null;

    function abort() {
        if (ctrl) {
            ctrl.abort();
            ctrl = null;
        }
        if (loading) {
            loading = false;
        }
        progress.clear();
    }

    // Ручная отмена пользователем — глушим и автодокачку.
    function cancel() {
        clearResume();
        abort();
    }

    const c = new AbortController();

    onMount(async () => {
        if (Loader.spa) {
            history.pushState = patchApi('pushState');
            history.replaceState = patchApi('replaceState');

            const tm = resolve => setTimeout(resolve, 2000);

            while (!c.signal.aborted) {
                while (!(injectTarget = Loader.injectTarget)) {
                    await new Promise(tm);
                    if (c.signal.aborted) return;
                }
                await waitEvents([c.signal, 'abort'], [window, 'pushState', 'replaceState', 'popstate']).promise;
                abort();
                await new Promise(tm);
            }
        } else {
            // Автодокачка: если попали на страницу антибота — пробуем пройти её сами (нажать «Я не робот»).
            if (getResume()) {
                for (let i = 0; i < 12 && !c.signal.aborted; i++) {
                    if (Loader.injectTarget) break;
                    const btn = Array.from(document.querySelectorAll('button, a, input')).find((b: any) => /я\s*не\s*робот/i.test(b.textContent || b.value || ''));
                    if (btn) { (btn as HTMLElement).click(); return; }
                    await new Promise(r => setTimeout(r, 1000));
                }
            }
            injectTarget = await Loader.injectTarget;
            // ...и если есть незавершённая докачка этой книги — продолжаем автоматически.
            const r = getResume();
            if (injectTarget && r && r.url === location.href) {
                await tick();
                loadBook(r.format === 'epub' ? formats.EPUB : formats.FB2);
            }
        }
    });

    onDestroy(() => {
        c.abort();
        abort();
        if (Loader.spa) {
            history.pushState['destroy']?.();
            history.replaceState['destroy']?.();
        }
    });

    const loadFB2 = loadBook.bind(null, formats.FB2);
    const loadEPUB = loadBook.bind(null, formats.EPUB);

    async function loadBook(format: EbookFormat) {
        if (loading || !injectTarget) return;
        let loader: Base;
        try {
            abort();
            loading = true;
            ctrl = new AbortController();
            notifications.clear();

            await tick();

            const attaches: ImageInfoMap = new Map();

            const epubTransform = async (part: Chapter) => {
                part.id = await sha256(part.title);
                part.text = await processHtml(epubChapter(part), ctrl, formats.EPUB, 1, attaches);
                part.text = epubPage(part);
                return part;
            };

            loader = new Loader();
            const chapters = await loader.parts(ctrl, attaches, format === formats.EPUB ? epubTransform : null);

            switch (format) {
                case formats.EPUB:
                    chapters.unshift(
                        await epubTransform({
                            title: 'Аннотация',
                            text: '<div>' + loader.description + loader.covers.map(c => `<p><img src="${c}"/></p>`).join('') + '</div>',
                        })
                    );

                    const images = Array.from(uniqValues(attaches));

                    const annotation = parse(chapters[0].text).querySelector('section');
                    annotation.firstElementChild.remove();
                    const renderInfo = {
                        ...loader,
                        cover: attaches.get(loader.covers[0]),
                        isoDate: loader.isoDate,
                        uuid: 'urn:uuid:' + (await createUUIDv5(loader.title + loader.subtitle + chapters.map(c => c.title).join(''))),
                        annotation: annotation.innerText.trim(),
                        chapters,
                        images,
                    };
                    annotation.ownerDocument.open();

                    attaches.clear();

                    const epubMime = 'application/epub+zip';
                    clearResume();
                    return saveAs(
                        new Blob(
                            Array.from(
                                zip([
                                    //
                                    { path: 'mimetype', data: epubMime },
                                    { path: 'META-INF/container.xml', data: epubContainer },
                                    { path: 'META-INF/com.apple.ibooks.display-options.xml', data: epubApple },
                                    { path: 'OEBPS/toc.ncx', data: epubToc(renderInfo) },
                                    { path: 'OEBPS/nav.xhtml', data: epubNav(renderInfo) },
                                    { path: 'OEBPS/content.opf', data: epubOpf(renderInfo) },
                                    ...images.map((a: ImageInfo) => ({ path: 'OEBPS/images/' + a.id + a.ext, data: a.data() })),
                                    ...chapters.map(a => ({ path: `OEBPS/${a.id}.xhtml`, data: a.text })),
                                ])
                            ),
                            { type: epubMime }
                        ),
                        loader.bookAlias + '.epub'
                    );
                case formats.FB2:
                    if (loader.genres.length < 1) {
                        loader.genres.push('unrecognised');
                    }
                    const cover = await (loader.covers[0] && downloadImage('Обложка', loader.covers[0], attaches, ctrl));
                    await cover?.b64();
                    const blobParts = [
                        '<?xml version="1.0" encoding="utf-8"?><FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">',
                        fb2Description({
                            ...loader,
                            cover,
                            annotation: await processHtml('<div>' + loader.description + '</div>', ctrl, format, concurrency),
                            shortDate: loader.date('YYYY-MM-DD'),
                            fullDate: loader.date('DD.MM.YYYY'),
                        }),
                        '<body>',
                        await processHtml(fb2Content({ title: loader.title, chapters }), ctrl, format, concurrency, attaches),
                        '</body>',
                    ];
                    for (const img of uniqValues(attaches)) {
                        blobParts.push(`<binary id="${cover && cover.id == img.id ? 'cover' : img.id}" content-type="${img.mime}">`, await img.b64(), '</binary>');
                    }
                    attaches.clear();
                    blobParts.push('</FictionBook>');
                    clearResume();
                    return saveAs(
                        new Blob(blobParts, {
                            type: 'application/x-fictionbook+xml;charset=utf-8',
                        }),
                        loader.bookAlias + '.fb2'
                    );
            }
        } catch (e) {
            if (e?.name === 'BotWallError' && loader?.bookAlias) {
                // Автодокачка: сохраняем прогресс, перезагружаем и продолжаем сами.
                const done = await cacheCount(`${loader.bookAlias}::https`);
                const prev = getResume();
                // если за прошлый заход не прибавилось глав — считаем "застряли"
                const stall = (prev && prev.url === location.href && done <= (prev.done || 0)) ? (prev.stall || 0) + 1 : 0;
                if (stall < 4) {
                    setResume({ url: location.href, format: format === formats.EPUB ? 'epub' : 'fb2', done, stall });
                    notifications.add(`Антибот заблокировал. Скачано глав: ${done}.\nПерезагружаю и продолжаю автоматически…\nЕсли появится «Я не робот» — пройдите его (дальше всё само).`);
                    setTimeout(() => location.reload(), 4000);
                    return;
                }
                // 4 захода без прогресса — IP, видимо, в бане; останавливаемся.
                clearResume();
                notifications.add({ name: 'BotWallError', message: `Скачано глав: ${done}. Сайт держит блокировку.\nПодождите 20-30 минут не заходя на сайт, затем снова нажмите «Скачать» — докачка продолжится с этого места.` });
            } else if (e?.name != 'AbortError') {
                console.error(e);
                notifications.add(e);
            }
        } finally {
            abort();
        }
    }

    console.log(APP_TITLE + ' ' + APP_VERSION);
</script>

<style type="text/scss" global>
    @import './_mixins.scss';
    #APP_TITLE_noquotes {
        @include overlay;
    }
</style>

{#if loading}
    <Preloader on:cancel={cancel} color={Loader.color} />
{:else if injectTarget}
    <Window on:save={loadEPUB} />
    <ContextMenu>
        <ContextMenuItem label={MENU_TITLE_FB2} on:trigger={loadFB2} />
        <ContextMenuItem label={MENU_TITLE_EPUB} on:trigger={loadEPUB} />
    </ContextMenu>
    <button class={Loader.component} on:click={loadFB2} use:inject={injectTarget}>{MENU_TITLE_FB2}</button>
    <button class={Loader.component} on:click={loadEPUB} use:inject={injectTarget}>{MENU_TITLE_EPUB}</button>
{/if}
<NotificationsDisplay />
