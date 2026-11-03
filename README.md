# VIP
Vue 3 + Ionic + Capacitor + PrimeVue starter.

## Stack
- **UI**: PrimeVue 4 (ưu tiên) + PrimeFlex + PrimeIcons
- **Native**: Capacitor 8 + Ionic Vue (shell / lifecycle)
- **State**: Pinia + persistedstate
- **Form**: vee-validate + zod
- **i18n**: vue-i18n (vi / en / zh-tw)

## Chạy dự án
```bash
npm install
npm run dev
```

## Capacitor
```bash
npm run build
npx cap add android
npx cap add ios
npx cap sync
```

# Thêm 
implementation fileTree(dir: 'src/main/libs', include: ['*.jar', '*.aar'])
implementation fileTree(dir: 'libs', include: ['*.jar', '*.aar'])

```bash
npm run build
npx cap sync android
```