import { TranslateLoader } from '@ngx-translate/core';
import { Observable, of } from 'rxjs';
import { TRANSLATIONS } from './translations';

/**
 * Simple loader that serves in-memory translation maps to ngx-translate.
 */
export class StaticTranslateLoader implements TranslateLoader {
  getTranslation(lang: string): Observable<Record<string, any>> {
    const fallback = TRANSLATIONS['en'] || {};
    return of(TRANSLATIONS[lang] || fallback);
  }
}
