import { ApplicationConfig, importProvidersFrom, provideBrowserGlobalErrorListeners, provideZoneChangeDetection } from '@angular/core';
import { provideRouter, RouteReuseStrategy } from '@angular/router';

import { routes } from './app.routes';
import {provideAnimationsAsync} from '@angular/platform-browser/animations/async';
import {provideOptimus} from '@openng/optimus-ui/config';
import Aura from '@openng/optimus-ui-themes/aura';
import {definePreset} from '@openng/optimus-ui-themes';
import { TranslateLoader, TranslateModule, provideTranslateService } from '@ngx-translate/core';
import {PortInterceptor} from './interceptors/PortInterceptor';
import {HTTP_INTERCEPTORS, provideHttpClient, withFetch, withInterceptorsFromDi} from '@angular/common/http';
import {MessageService} from '@openng/optimus-ui/api';
import { StaticTranslateLoader } from './i18n/static-translate-loader';
import { ProjectRouteReuseStrategy } from './services/project-route-reuse-strategy';

const Raccoon = definePreset(Aura, {
  semantic: {
    primary: {
      50: '{amber.50}',
      100: '{amber.100}',
      200: '{amber.200}',
      300: '{amber.300}',
      400: '{amber.400}',
      500: '{amber.500}',
      600: '{amber.600}',
      700: '{amber.700}',
      800: '{amber.800}',
      900: '{amber.900}',
      950: '{amber.950}'
    },
    colorScheme: {
      light: {
        surface: { 0: '#fffdf9', 50: '{stone.50}', 100: '{stone.100}', 200: '{stone.200}', 300: '{stone.300}', 400: '{stone.400}', 500: '{stone.500}', 600: '{stone.600}', 700: '{stone.700}', 800: '{stone.800}', 900: '{stone.900}', 950: '{stone.950}' },
        primary: {
          color: '{amber.800}',
          contrastColor: '#fffdf9',
          hoverColor: '{amber.900}',
          activeColor: '{amber.950}'
        },
        highlight: {
          background: '{amber.100}',
          focusBackground: '{amber.200}',
          color: '{amber.950}',
          focusColor: '{amber.950}'
        }
      },
      dark: {
        surface: {
          0: 'var(--rc-text)',
          50: 'var(--rc-text)',
          100: 'var(--rc-muted)',
          200: 'var(--rc-muted)',
          300: 'var(--rc-dim)',
          400: 'var(--rc-dim)',
          500: 'var(--rc-control-border)',
          600: 'var(--rc-control-border)',
          700: 'var(--rc-border)',
          800: 'var(--rc-elevated)',
          900: 'var(--rc-surface)',
          950: 'var(--rc-field)'
        },
        primary: {
          color: 'var(--rc-accent)',
          contrastColor: 'var(--rc-on-accent)',
          hoverColor: 'var(--rc-accent-hover)',
          activeColor: 'var(--rc-accent)'
        },
        highlight: {
          background: 'var(--rc-accent-dim)',
          focusBackground: 'var(--rc-accent-glow)',
          color: 'var(--rc-text)',
          focusColor: 'var(--rc-text)'
        }
      }
    }
  }
});


export const appConfig: ApplicationConfig = {
  providers: [
    MessageService,
    provideAnimationsAsync(),
    provideOptimus({
      theme: {
        preset: Raccoon,
        options: {
          darkModeSelector: ".dark"
        }
      }
    }),
    provideBrowserGlobalErrorListeners(),
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes),
    { provide: RouteReuseStrategy, useClass: ProjectRouteReuseStrategy },
    importProvidersFrom(TranslateModule.forRoot({
      loader: {
        provide: TranslateLoader,
        useClass: StaticTranslateLoader,
      },
      defaultLanguage: 'en'
    })),
    provideTranslateService(),
    provideHttpClient(withFetch(), withInterceptorsFromDi()),
    {
      provide: HTTP_INTERCEPTORS,
      useClass: PortInterceptor,
      multi: true,
    },
  ]
};
