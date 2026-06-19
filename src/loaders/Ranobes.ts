import dayjs from 'dayjs';
import pMap from 'p-map';

import { progress } from '../stores';
import { delay, downloadImage, getElements, ImageInfoMap, loadDom } from '../utils';
import { cacheGet, cacheSet } from '../cache';
import { Base, Chapter } from './Base';

export class Ranobes extends Base {

    public static readonly component = 'btn btn-block';
    public static readonly color = (a: number) => `rgba(149,172,124,${a})`;

    public static get injectTarget(): HTMLElement {
        return document.getElementById('mc-fs-rate');
    }

    async parts(ctrl: AbortController, cache: ImageInfoMap, mapper: (v: Chapter) => Promise<Chapter>) {
        const q = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T | null;
        const qa = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => Array.from(root.querySelectorAll(sel)) as T[];
        const meta = (name: string) => (q<HTMLMetaElement>(`meta[property="${name}"], meta[name="${name}"]`)?.content || '').trim();

        // Идентификатор книги достаём из ссылки на оглавление вида /chapters/<alias>/.
        // Раньше брался из микроразметки, которую сайт убрал в 2024-2025 годах.
        const chaptersLink = (q<HTMLAnchorElement>('.r-fullstory-chapters-foot a[href*="/chapters/"]') || q<HTMLAnchorElement>('a[href*="/chapters/"]'))?.href || '';
        const aliasMatch = chaptersLink.match(/\/chapters\/([^/]+)\//);
        if (!aliasMatch) {
            throw new Error('Не удалось найти ссылку на оглавление книги — возможно, снова изменилась вёрстка сайта.');
        }
        const bookAlias = this.bookAlias = aliasMatch[1];
        const origin = new URL(chaptersLink).origin;

        this.covers = [meta('og:image') || q<HTMLImageElement>('.poster img, .r-fullstory-poster img, .modal-image img')?.src].filter(Boolean) as string[];

        const yearText = qa('.r-fullstory-spec li').find(li => /Год издания/i.test(li.textContent || ''))?.textContent || '';
        const year = (yearText.match(/\d{4}/) || [])[0];
        this.d = dayjs(year ? `${year}-01-01` : undefined);

        this.genres = qa('#mc-fs-genre a').map(a => (a.textContent || '').trim()).filter(Boolean);
        this.keywords = qa('#mc-fs-keyw a').map(a => (a.textContent || '').trim()).filter(Boolean).join(', ');
        this.title = this.extractTitle(document);
        this.subtitle = (q('h1 .subtitle')?.textContent || '').trim();

        const descEl = q('.r-desription .cont-text') || q('.r-desription');
        if (descEl) {
            const clone = descEl.cloneNode(true) as HTMLElement;
            qa('style, script, button', clone).forEach(n => n.remove());
            this.description = clone.innerHTML.trim();
        } else {
            this.description = meta('og:description');
        }

        //todo this.lang = undefined;
        this.authors = qa<HTMLAnchorElement>('a[href*="/cloud/authors/"]').map(a => ({ name: (a.textContent || '').trim(), homePage: a.href }));

        // Список глав кэшируем, чтобы при докачке не перечитывать оглавление заново.
        const listKey = `${bookAlias}::list`;
        let items: string[] = await cacheGet<string[]>(listKey) || [];
        if (!items.length) {
            for (let pageIndex = 1; ; ++pageIndex) {
                const doc = await loadDom(`${origin}/chapters/${bookAlias}/page/${pageIndex}/`, ctrl.signal);
                if (!doc) break;
                doc.querySelectorAll(`.cat_block a[href*="/chapters/${bookAlias}/"]`).forEach((a: HTMLAnchorElement) => items.push(a.href));
            }
            items.reverse(); // от старых к новым (порядок чтения)
            await cacheSet(listKey, items);
        }

        progress.total = items.length;

        return pMap(
            items,
            async url => {
                try {
                    // Докачка: уже скачанные главы берём из кэша мгновенно и без запроса —
                    // так после блокировки антиботом перезапуск продолжает с места.
                    const chKey = `${bookAlias}::${url}`;
                    let raw = await cacheGet<Chapter>(chKey);

                    if (!raw) {
                        // Пауза ~1.5с между РЕАЛЬНЫМИ запросами: на меньшей паузе сайт включает антибот.
                        await delay(1500, ctrl.signal);

                        let text = '';
                        let title = '';

                        const pages = [url];

                        for (const page of pages) {
                            // Валидируем, что #arrticle реально с контентом — иначе антибот мог отдать
                            // пустую оболочку, и loadDom повторит запрос (а не сохранит пустую главу).
                            const doc = await loadDom(page, ctrl.signal, 'GET', undefined, d => {
                                const a = d.getElementById('arrticle');
                                return !!a && (a.children.length > 0 || !!a.textContent.trim());
                            });
                            if (!doc) break;
                            const content = doc.getElementById('arrticle');
                            if (!content) {
                                throw { name: 'ParseError', message: `Не удалось извлечь текст главы (нет #arrticle):\n${page}` };
                            }
                            text += content.outerHTML;
                            if (!title) {
                                title = this.extractTitle(doc);
                                const nav = doc.querySelector('.splitnewsnavigation');
                                if (nav) {
                                    nav.querySelectorAll(`a[href*="/chapters/${bookAlias}/"]`).forEach((a: HTMLAnchorElement) => pages.push(a.href));
                                }
                            }
                            for (const img of getElements(content, 'img')) {
                                await downloadImage(title, img.src, cache, ctrl);
                            }
                            doc.open();
                        }

                        raw = { title, text };
                        await cacheSet(chKey, raw);
                    }

                    progress.inc();
                    return mapper ? await mapper({ ...raw }) : { ...raw };
                } catch (e) {
                    ctrl.abort();
                    throw e;
                }
            },
            // Последовательно (не 5 параллельно): залп запросов провоцирует
            // проверку Cloudflare, из-за чего главы возвращаются как заглушки.
            { concurrency: 1 }
        );
    }
}