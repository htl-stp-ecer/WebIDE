import { ApplicationConfig, provideBrowserGlobalErrorListeners, provideZoneChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';

import { routes } from './app.routes';
import {provideAnimationsAsync} from '@angular/platform-browser/animations/async';
import {providePrimeNG} from 'primeng/config';
import Aura from '@primeuix/themes/aura';
import {definePreset} from '@primeuix/themes';
import {provideTranslateService} from '@ngx-translate/core';
import {PortInterceptor} from './interceptors/PortInterceptor';
import {HTTP_INTERCEPTORS, provideHttpClient, withFetch, withInterceptorsFromDi} from '@angular/common/http';
import {MessageService} from 'primeng/api';

const Noir = definePreset(Aura, {
  semantic: {
    primary: {
      50: '{zinc.50}',
      100: '{zinc.100}',
      200: '{zinc.200}',
      300: '{zinc.300}',
      400: '{zinc.400}',
      500: '{zinc.500}',
      600: '{zinc.600}',
      700: '{zinc.700}',
      800: '{zinc.800}',
      900: '{zinc.900}',
      950: '{zinc.950}'
    },
    colorScheme: {
      light: {
        primary: {
          color: '{zinc.950}',
          inverseColor: '#ffffff',
          hoverColor: '{zinc.900}',
          activeColor: '{zinc.800}'
        },
        highlight: {
          background: '{zinc.950}',
          focusBackground: '{zinc.700}',
          color: '#ffffff',
          focusColor: '#ffffff'
        }
      },
      dark: {
        primary: {
          color: '{zinc.50}',
          inverseColor: '{zinc.950}',
          hoverColor: '{zinc.100}',
          activeColor: '{zinc.200}'
        },
        highlight: {
          background: 'rgba(250, 250, 250, .16)',
          focusBackground: 'rgba(250, 250, 250, .24)',
          color: 'rgba(255,255,255,.87)',
          focusColor: 'rgba(255,255,255,.87)'
        }
      }
    }
  }
});


export const appConfig: ApplicationConfig = {
  providers: [
    MessageService,
    provideAnimationsAsync(),
    providePrimeNG({
      theme: {
        preset: Noir,
        options: {
          darkModeSelector: ".dark-theme"
        }
      }
    }),
    provideBrowserGlobalErrorListeners(),
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes),
    provideTranslateService(),
    provideHttpClient(withFetch(), withInterceptorsFromDi()),
    {
      provide: HTTP_INTERCEPTORS,
      useClass: PortInterceptor,
      multi: true,
    },
  ]
};
