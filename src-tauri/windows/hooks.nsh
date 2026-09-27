; Tillegg til Blad-installeren.
;
; Legger «Blad – slå sammen PDF-er» i «Send til»-menyen i Utforsker: marker
; flere PDF-er, høyreklikk og velg Send til → Blad – slå sammen PDF-er. Alle
; filene sendes til én Blad-prosess, som åpner sammenslåingen med dem.
; (Fila er lagret som UTF-8 med BOM, så NSIS leser æøå riktig.)

!define BLAD_SENDTO "$APPDATA\Microsoft\Windows\SendTo\Blad – slå sammen PDF-er.lnk"

!macro NSIS_HOOK_POSTINSTALL
  CreateShortcut "${BLAD_SENDTO}" "$INSTDIR\${MAINBINARYNAME}.exe" "--merge" "$INSTDIR\${MAINBINARYNAME}.exe" 0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  Delete "${BLAD_SENDTO}"
!macroend
