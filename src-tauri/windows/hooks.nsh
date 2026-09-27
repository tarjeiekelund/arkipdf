; Tillegg til ArkiPDF-installeren.
;
; Legger «ArkiPDF – slå sammen PDF-er» i «Send til»-menyen i Utforsker: marker
; flere PDF-er, høyreklikk og velg Send til → ArkiPDF – slå sammen PDF-er. Alle
; filene sendes til én ArkiPDF-prosess, som åpner sammenslåingen med dem.
; (Fila er lagret som UTF-8 med BOM, så NSIS leser æøå riktig.)

!define ARKIPDF_SENDTO "$APPDATA\Microsoft\Windows\SendTo\ArkiPDF – slå sammen PDF-er.lnk"
; Snarveien fra da appen het Blad.
!define OLD_SENDTO "$APPDATA\Microsoft\Windows\SendTo\Blad – slå sammen PDF-er.lnk"

!macro NSIS_HOOK_POSTINSTALL
  Delete "${OLD_SENDTO}"
  CreateShortcut "${ARKIPDF_SENDTO}" "$INSTDIR\${MAINBINARYNAME}.exe" "--merge" "$INSTDIR\${MAINBINARYNAME}.exe" 0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  Delete "${ARKIPDF_SENDTO}"
!macroend
