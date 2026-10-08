; Tillegg til ArkiPDF-installeren.
;
; Legger «ArkiPDF – slå sammen PDF-er» i «Send til»-menyen i Utforsker: marker
; flere PDF-er, høyreklikk og velg Send til → ArkiPDF – slå sammen PDF-er. Alle
; filene sendes til én ArkiPDF-prosess, som åpner sammenslåingen med dem.
;
; Legger også «Åpne i nytt ArkiPDF-vindu» i høyreklikkmenyen for PDF-er (i
; Windows 11 under «Vis flere alternativer»), uansett hvilket program som er
; standard for PDF. Fila åpnes i et eget vindu i stedet for som en fane.
; (Fila er lagret som UTF-8 med BOM, så NSIS leser æøå riktig.)

!define ARKIPDF_SENDTO "$APPDATA\Microsoft\Windows\SendTo\ArkiPDF – slå sammen PDF-er.lnk"
; Snarveien fra da appen het Blad.
!define OLD_SENDTO "$APPDATA\Microsoft\Windows\SendTo\Blad – slå sammen PDF-er.lnk"
!define ARKIPDF_VERB "Software\Classes\SystemFileAssociations\.pdf\shell\ArkiPDF.NyttVindu"

!macro NSIS_HOOK_POSTINSTALL
  Delete "${OLD_SENDTO}"
  CreateShortcut "${ARKIPDF_SENDTO}" "$INSTDIR\${MAINBINARYNAME}.exe" "--merge" "$INSTDIR\${MAINBINARYNAME}.exe" 0
  WriteRegStr HKCU "${ARKIPDF_VERB}" "" "Åpne i nytt ArkiPDF-vindu"
  WriteRegStr HKCU "${ARKIPDF_VERB}" "Icon" "$INSTDIR\${MAINBINARYNAME}.exe,0"
  WriteRegStr HKCU "${ARKIPDF_VERB}\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" --new-window "%1"'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  Delete "${ARKIPDF_SENDTO}"
  DeleteRegKey HKCU "${ARKIPDF_VERB}"
!macroend
