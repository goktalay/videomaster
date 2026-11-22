; Tüm Mastertool uygulamaları aynı yere kurulur:
;   tüm kullanıcılar: C:\Program Files\Mastertool\<Uygulama>
;   yalnız bu kullanıcı: %LOCALAPPDATA%\Programs\Mastertool\<Uygulama>
; Başlat menüsü: Master Tool › <Uygulama> (package.json → build.nsis.menuCategory).

!include "FileFunc.nsh"

; Eski klasörden taşınırken eski yolu tutan ayrı anahtar. Uygulamanın kendi anahtarına
; (INSTALL_REGISTRY_KEY) yazılmaz, çünkü yükseltmede eski kaldırıcı o anahtarı silebilir.
!define MT_MIGRATE_KEY "Software\Mastertool\Install"
!define MT_MIGRATE_VALUE "${PRODUCT_NAME}.OldLocation"

; ROOT altında önceki kurulum yolu Mastertool dışındaysa onu not et, sonra varsayılanı Mastertool yap.
!macro _mtSetDefaultDir ROOT NEWPATH
  ReadRegStr $R8 ${ROOT} "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $R8 != ""
  ${AndIf} $R8 != "${NEWPATH}"
    ReadRegStr $R9 ${ROOT} "${MT_MIGRATE_KEY}" "${MT_MIGRATE_VALUE}"
    ${If} $R9 == ""
      WriteRegStr ${ROOT} "${MT_MIGRATE_KEY}" "${MT_MIGRATE_VALUE}" "$R8"
    ${EndIf}
  ${EndIf}
  WriteRegExpandStr ${ROOT} "${INSTALL_REGISTRY_KEY}" InstallLocation "${NEWPATH}"
!macroend

; electron-builder varsayılan klasörü kayıt defterindeki önceki InstallLocation'dan okur; okunmadan önce
; bu değeri Mastertool yoluna çeviriyoruz. Böylece ilk kurulumda da, eski klasördeki bir sürümden
; yükseltmede de varsayılan Mastertool olur (kurulum sırasında klasör yine değiştirilebilir).
; HKLM'ye yazım yalnız yönetici olarak çalışan (tüm kullanıcılar) kurulumda başarılı olur, aksi halde yok sayılır.
; Kayıt görünümü hemen ardından electron-builder tarafından (check64BitAndSetRegView) yeniden ayarlanır.
!macro preInit
  ; electron-builder derleme sırasında kaldırıcıyı üretmek için bu kurulumu derleme makinesinde bir kez
  ; çalıştırır (BUILD_UNINSTALLER); o çalıştırmada derleyen bilgisayarın kayıt defterine yazılmasın.
  !ifndef BUILD_UNINSTALLER
    SetRegView 64
    !insertmacro _mtSetDefaultDir HKLM "$PROGRAMFILES64\Mastertool\${PRODUCT_NAME}"
    !insertmacro _mtSetDefaultDir HKCU "$LOCALAPPDATA\Programs\Mastertool\${PRODUCT_NAME}"
    SetRegView 32
    !insertmacro _mtSetDefaultDir HKLM "$PROGRAMFILES64\Mastertool\${PRODUCT_NAME}"
    !insertmacro _mtSetDefaultDir HKCU "$LOCALAPPDATA\Programs\Mastertool\${PRODUCT_NAME}"
  !endif
!macroend

; Yükseltmede electron-builder eski sürümün kaldırıcısını InstallLocation'daki (artık Mastertool) yola
; yönlendirdiği için eski klasördeki dosyalar kalırdı; kısayol ve kayıtlar zaten temizlenmiş olur.
; Kurulum bitince eski klasörü sil — yalnız bu uygulamanın exe'si ve kaldırıcısı oradaysa ve yeni yoldan farklıysa.
!macro customInstall
  ReadRegStr $R9 SHELL_CONTEXT "${MT_MIGRATE_KEY}" "${MT_MIGRATE_VALUE}"
  ${If} $R9 != ""
  ${AndIf} $R9 != "$INSTDIR"
  ${AndIf} ${FileExists} "$R9\${APP_EXECUTABLE_FILENAME}"
  ${AndIf} ${FileExists} "$R9\${UNINSTALL_FILENAME}"
    RMDir /r "$R9"
  ${EndIf}
  DeleteRegValue SHELL_CONTEXT "${MT_MIGRATE_KEY}" "${MT_MIGRATE_VALUE}"
  DeleteRegKey /ifempty SHELL_CONTEXT "${MT_MIGRATE_KEY}"
  DeleteRegKey /ifempty SHELL_CONTEXT "Software\Mastertool"
!macroend

; Kaldırmada geriye boş "SSH Master" ve (başka Mastertool uygulaması kalmadıysa) boş "Mastertool"
; klasörü kalmasın. RMDir /r değil: yalnız boş klasörleri siler, diğer uygulamalara dokunmaz.
; Kaldırıcının çalışma klasörü kurulum klasörü olduğundan önce oradan çıkılır (aksi halde silinemez).
!macro customUnInstall
  SetOutPath "$TEMP"
  RMDir "$INSTDIR"
  ${GetParent} "$INSTDIR" $R0
  RMDir "$R0"
!macroend
